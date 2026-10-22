import { Result, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ProjectId, Sha, WorktreeId } from "../ids.ts";
import {
  formatFactLine,
  formatHandoffMessage,
  HandoffBranch,
  HandoffCutAt,
  HandoffMachine,
  type HandoffTrailers,
  handoffWorktreeName,
  HexSha,
  isEnvPath,
  parseHandoffMessage,
  readReceiveAnswer,
  readTermsAnswer,
  takesHandoffs,
  type WireAnswer,
  WorktreeHandoff,
} from "./handoff.ts";
import { Worktree, WorktreeName } from "./worktree.ts";

const TIP = "3e73da3c0ffee0000000000000000000000000ab";
const BASE = "1a2b3c4d0000000000000000000000000000000c";
const HEAD = Sha.make("9c1e2f3aa000000000000000000000000000000b");

const trailers = (localBranch: string | null): HandoffTrailers => ({
  machine: HandoffMachine.make("dana-mbp"),
  localBranch: localBranch === null ? null : HandoffBranch.make(localBranch),
  cutAt: HandoffCutAt.make("2026-10-18T07:42:05.000Z"),
  defaultTip: HexSha.make(TIP),
  mergeBase: HexSha.make(BASE),
});

const message = (...lines: ReadonlyArray<string>) => `mend handoff\n\n${lines.join("\n")}\n`;

const faultOf = (text: string) => {
  const parsed = parseHandoffMessage(text);
  return Result.isFailure(parsed) ? parsed.failure.reason : "parsed";
};

describe("handoff message", () => {
  it("writes the subject, a blank line and the trailers in a fixed order", () => {
    expect(formatHandoffMessage(trailers("fix/login"))).toBe(
      [
        "mend handoff",
        "",
        "Mend-Machine: dana-mbp",
        "Mend-Branch: fix/login",
        "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
        `Mend-Default-Tip: ${TIP}`,
        `Mend-Merge-Base: ${BASE}`,
        "",
      ].join("\n"),
    );
  });

  it("leaves Mend-Branch out when HEAD is detached", () => {
    expect(formatHandoffMessage(trailers(null))).not.toContain("Mend-Branch");
  });

  it("round-trips attached and detached trailers", () => {
    for (const value of [trailers("fix/login"), trailers(null), trailers("Ünïcode/brånch")]) {
      expect(parseHandoffMessage(formatHandoffMessage(value))).toEqual(Result.succeed(value));
    }
  });

  it("round-trips any trailers the schema admits", () => {
    const printable = fc
      .string({ unit: "grapheme", minLength: 1, maxLength: 40 })
      .filter((value) => Schema.is(HandoffMachine)(value));
    fc.assert(
      fc.property(
        printable,
        fc.option(printable, { nil: null }),
        fc.date({
          min: new Date(0),
          max: new Date("2100-01-01"),
          noInvalidDate: true,
        }),
        fc.stringMatching(/^[0-9a-f]{64}$/),
        fc.stringMatching(/^[0-9a-f]{40}$/),
        (machine, branch, cut, tip, base) => {
          const value: HandoffTrailers = {
            machine: HandoffMachine.make(machine),
            localBranch: branch === null ? null : HandoffBranch.make(branch),
            cutAt: HandoffCutAt.make(cut.toISOString()),
            defaultTip: HexSha.make(tip),
            mergeBase: HexSha.make(base),
          };
          expect(parseHandoffMessage(formatHandoffMessage(value))).toEqual(Result.succeed(value));
        },
      ),
    );
  });

  it("accepts the trailers in any order and without the final newline", () => {
    expect(
      faultOf(
        `mend handoff\n\nMend-Merge-Base: ${BASE}\nMend-Default-Tip: ${TIP}\nMend-Cut-At: 2026-10-18T07:42:05.000Z\nMend-Machine: m`,
      ),
    ).toBe("parsed");
  });

  it("refuses a message that is not a handoff's", () => {
    expect(faultOf("wip\n\nMend-Machine: m\n")).toBe("not-a-handoff");
    expect(faultOf("mend handoff\nMend-Machine: m\n")).toBe("not-a-handoff");
    expect(faultOf("")).toBe("not-a-handoff");
  });

  it("refuses a duplicate trailer", () => {
    const text = message(
      "Mend-Machine: a",
      "Mend-Machine: b",
      "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
      `Mend-Default-Tip: ${TIP}`,
      `Mend-Merge-Base: ${BASE}`,
    );
    expect(parseHandoffMessage(text)).toEqual(
      Result.fail({
        reason: "duplicate-trailer",
        detail: "Mend-Machine appears more than once",
      }),
    );
    expect(
      faultOf(
        message(
          "Mend-Machine: a",
          "Mend-Branch: x",
          "Mend-Branch: x",
          "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
          `Mend-Default-Tip: ${TIP}`,
          `Mend-Merge-Base: ${BASE}`,
        ),
      ),
    ).toBe("duplicate-trailer");
  });

  it("refuses a missing required trailer", () => {
    expect(faultOf(message("Mend-Machine: a", "Mend-Cut-At: 2026-10-18T07:42:05.000Z"))).toBe(
      "missing-trailer",
    );
    expect(
      faultOf(message("Mend-Cut-At: 2026-10-18T07:42:05.000Z", `Mend-Default-Tip: ${TIP}`)),
    ).toBe("missing-trailer");
    expect(faultOf(message("Mend-Machine: a", `Mend-Default-Tip: ${TIP}`))).toBe("missing-trailer");
    expect(
      faultOf(
        message(
          "Mend-Machine: a",
          "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
          `Mend-Default-Tip: ${TIP}`,
        ),
      ),
    ).toBe("missing-trailer");
  });

  it("refuses garbled lines and values", () => {
    const valid = {
      machine: "Mend-Machine: a",
      cutAt: "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
      tip: `Mend-Default-Tip: ${TIP}`,
      base: `Mend-Merge-Base: ${BASE}`,
    };
    const garbled = [
      message(valid.machine, valid.cutAt, valid.tip, valid.base, "Signed-off-by: someone"),
      message(valid.machine, valid.cutAt, valid.tip, valid.base, "Mend-Branch:fix"),
      message(valid.machine, valid.cutAt, valid.tip, valid.base, ""),
      message(valid.machine, valid.cutAt, "Mend-Default-Tip: 3E73DA3", valid.base),
      message(valid.machine, valid.cutAt, `Mend-Default-Tip: ${TIP.toUpperCase()}`, valid.base),
      message(valid.machine, valid.cutAt, valid.tip, "Mend-Merge-Base: 1a2b3c4"),
      message(valid.machine, "Mend-Cut-At: 2026-10-18T07:42:05Z", valid.tip, valid.base),
      message(valid.machine, "Mend-Cut-At: 2026-10-18T10:42:05+03:00", valid.tip, valid.base),
      message(valid.machine, "Mend-Cut-At: yesterday", valid.tip, valid.base),
      message(`Mend-Machine: ${"m".repeat(65)}`, valid.cutAt, valid.tip, valid.base),
      message("Mend-Machine:  padded", valid.cutAt, valid.tip, valid.base),
      message("Mend-Machine: tab\there", valid.cutAt, valid.tip, valid.base),
      message(valid.machine, "Mend-Branch: fix\r", valid.cutAt, valid.tip, valid.base),
    ];
    for (const text of garbled) expect(faultOf(text), text).toBe("garbled-trailer");
  });

  it("admits a 64-character machine name and refuses an empty one", () => {
    expect(Schema.is(HandoffMachine)("m".repeat(64))).toBe(true);
    expect(Schema.is(HandoffMachine)("")).toBe(false);
    expect(Schema.is(HandoffMachine)("a\nb")).toBe(false);
  });
});

describe("WorktreeHandoff", () => {
  const row = {
    machine: "dana-mbp",
    localBranch: "fix/login",
    cutAt: "2026-10-18T07:42:05.000Z",
    head: "a".repeat(40),
    index: "b".repeat(40),
    checkpoint: "c".repeat(64),
    mergeBase: "d".repeat(40),
    worktreeTree: "e".repeat(40),
    indexTree: "f".repeat(40),
    ownerUserId: "user-dana",
    deltaPack: "packs/pack-0123.pack",
    commitsAhead: 2,
    previous: null,
  };

  it("decodes the jsonb value and encodes it back unchanged", () => {
    const decoded = Schema.decodeUnknownSync(WorktreeHandoff)(row);
    expect(Schema.encodeSync(WorktreeHandoff)(decoded)).toEqual(row);
    expect(
      Schema.decodeUnknownSync(WorktreeHandoff)({ ...row, localBranch: null }).localBranch,
    ).toBe(null);
  });

  it("refuses a short sha and an empty pack key", () => {
    expect(Schema.is(WorktreeHandoff)({ ...row, head: "abc1234" })).toBe(false);
    expect(Schema.is(WorktreeHandoff)({ ...row, worktreeTree: "abc1234" })).toBe(false);
    expect(Schema.is(WorktreeHandoff)({ ...row, deltaPack: "" })).toBe(false);
  });

  it("is null on a Worktree a server from before handoffs lists, and carried when present", () => {
    const listed = {
      id: WorktreeId.make("wt-1"),
      projectId: ProjectId.make("project-1"),
      name: "fix-login",
      directory: "fix-login",
      branch: "mend/fix-login",
      baseSha: "d".repeat(40),
      baseRef: "main",
      createdAt: "2026-10-18T07:42:05.000Z",
      updatedAt: "2026-10-18T07:42:05.000Z",
    };
    expect(Schema.decodeUnknownSync(Worktree)(listed).handoff).toBe(null);
    expect(Schema.decodeUnknownSync(Worktree)({ ...listed, handoff: null }).handoff).toBe(null);
    expect(Schema.decodeUnknownSync(Worktree)({ ...listed, handoff: row }).handoff).toEqual(
      Schema.decodeUnknownSync(WorktreeHandoff)(row),
    );
  });
});

const none = () => false;
const isGitComponent = (name: string) =>
  !name.includes("..") &&
  !name.includes("@{") &&
  !name.endsWith(".") &&
  !name.endsWith(".lock") &&
  !name.startsWith(".");

describe("handoffWorktreeName", () => {
  it("slugs the branch", () => {
    expect(handoffWorktreeName("fix/login", HEAD, none)).toBe("fix-login");
    expect(handoffWorktreeName("Feature/Big_Thing", HEAD, none)).toBe("feature-big_thing");
    expect(handoffWorktreeName("a//b  c", HEAD, none)).toBe("a-b-c");
    expect(handoffWorktreeName("-_.release/1.2", HEAD, none)).toBe("release-1.2");
    expect(handoffWorktreeName("wip..again", HEAD, none)).toBe("wip.again");
    expect(handoffWorktreeName("topic/", HEAD, none)).toBe("topic");
    expect(handoffWorktreeName("topic.", HEAD, none)).toBe("topic");
    expect(handoffWorktreeName("deps.lock", HEAD, none)).toBe("deps-lock");
    expect(handoffWorktreeName("me@{now}", HEAD, none)).toBe("me-now");
  });

  it("names a detached HEAD, or a branch with nothing left of it, after the head", () => {
    expect(handoffWorktreeName(null, HEAD, none)).toBe("handoff-9c1e2f3");
    expect(handoffWorktreeName("ünï/çødé", HEAD, none)).toBe("n-d");
    expect(handoffWorktreeName("日本語", HEAD, none)).toBe("handoff-9c1e2f3");
    expect(handoffWorktreeName("---", HEAD, none)).toBe("handoff-9c1e2f3");
  });

  it("cuts a long branch to 64 characters", () => {
    const name = handoffWorktreeName(`${"x".repeat(63)}.lock`, HEAD, none);
    expect(name).toBe("x".repeat(63));
    expect(handoffWorktreeName("y".repeat(100), HEAD, none)).toBe("y".repeat(64));
  });

  it("counts up past taken names and stays within 64 characters", () => {
    const taken = new Set(["fix-login", "fix-login-2"]);
    expect(handoffWorktreeName("fix/login", HEAD, (name) => taken.has(name))).toBe("fix-login-3");
    expect(handoffWorktreeName(null, HEAD, (name) => name === "handoff-9c1e2f3")).toBe(
      "handoff-9c1e2f3-2",
    );
    const long = "z".repeat(64);
    expect(handoffWorktreeName(long, HEAD, (name) => name === long)).toBe(`${"z".repeat(62)}-2`);
    const dotted = `${"z".repeat(61)}.ab`;
    expect(handoffWorktreeName(dotted, HEAD, (name) => name === dotted)).toBe(
      `${"z".repeat(61)}-2`,
    );
  });

  it("always answers a WorktreeName that is a git ref component and is not taken", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 120 }), { nil: null }),
        fc.stringMatching(/^[0-9a-f]{40}$/),
        fc.array(fc.string({ maxLength: 70 }), { maxLength: 5 }),
        fc.nat({ max: 4 }),
        (branch, head, extra, preTaken) => {
          const first = handoffWorktreeName(branch, Sha.make(head), none);
          const taken = new Set(extra);
          let current = first;
          for (let i = 0; i < preTaken; i++) {
            taken.add(current);
            current = handoffWorktreeName(branch, Sha.make(head), (name) => taken.has(name));
          }
          expect(Schema.is(WorktreeName)(current), current).toBe(true);
          expect(isGitComponent(current), current).toBe(true);
          expect(taken.has(current)).toBe(false);
        },
      ),
    );
  });
});

describe("isEnvPath", () => {
  it("matches every basename starting with .env", () => {
    for (const path of [
      ".env",
      ".env.local",
      ".env.example",
      ".environment",
      "apps/web/.env.local",
    ]) {
      expect(isEnvPath(path), path).toBe(true);
    }
    for (const path of ["env", "dot.env", ".envrc/x", "config/.npmrc", ".en"]) {
      expect(isEnvPath(path), path).toBe(false);
    }
  });
});

describe("formatFactLine", () => {
  const counts = {
    commitsAhead: 2,
    uncommitted: 3,
    untracked: 1,
    defaultBranch: "main",
  };

  it("names commits, uncommitted and untracked files", () => {
    expect(formatFactLine(counts)).toBe(
      "2 commits ahead of main · 3 uncommitted files · 1 untracked",
    );
  });

  it("says one in the singular", () => {
    expect(
      formatFactLine({
        ...counts,
        commitsAhead: 1,
        uncommitted: 1,
        untracked: 0,
      }),
    ).toBe("1 commit ahead of main · 1 uncommitted file");
  });

  it("says even and none for zero, and leaves zero untracked out", () => {
    expect(
      formatFactLine({
        commitsAhead: 0,
        uncommitted: 0,
        untracked: 0,
        defaultBranch: "trunk",
      }),
    ).toBe("even with trunk · no uncommitted files");
    expect(
      formatFactLine({
        ...counts,
        commitsAhead: 0,
        uncommitted: 0,
        untracked: 4,
      }),
    ).toBe("even with main · no uncommitted files · 4 untracked");
  });
});

const answer = (status: number | null, body: unknown = null): WireAnswer => ({ status, body });
const routerNotFound = answer(404, "Not Found");
const projectNotFound = answer(404, { _tag: "NotFound", message: "no project handoff-probe" });

describe("readTermsAnswer", () => {
  it("reads the two limits from a 200", () => {
    expect(readTermsAnswer(answer(200, { bundleBytes: 64, fileBytes: 8, extra: true }))).toEqual({
      _tag: "terms",
      bundleBytes: 64,
      fileBytes: 8,
    });
  });

  it.each([[null], [{ bundleBytes: 64 }], [{ bundleBytes: "64", fileBytes: 8 }], [[64, 8]]])(
    "calls a 200 it cannot read unreadable (%j)",
    (body) => {
      expect(readTermsAnswer(answer(200, body))).toEqual({ _tag: "unreadable" });
    },
  );

  it("calls the router's untagged 404 an old server", () => {
    expect(readTermsAnswer(routerNotFound)).toEqual({ _tag: "oldServer" });
    expect(readTermsAnswer(answer(404, null))).toEqual({ _tag: "oldServer" });
    expect(readTermsAnswer(answer(404, { _tag: 7 }))).toEqual({ _tag: "oldServer" });
  });

  it.each([
    projectNotFound,
    answer(422, { _tag: "HandoffRefused", message: "co-located store" }),
    answer(401, null),
    answer(201, { bundleBytes: 64, fileBytes: 8 }),
    answer(503, null),
    answer(null),
  ])("passes any other answer back as refused (%j)", (refused) => {
    expect(readTermsAnswer(refused)).toEqual({ _tag: "refused", answer: refused });
  });
});

describe("readReceiveAnswer", () => {
  it("passes a 2xx body through as received", () => {
    const body = { session: { id: "s" } };
    expect(readReceiveAnswer(answer(201, body))).toEqual({ _tag: "received", body });
    expect(readReceiveAnswer(answer(200, null))).toEqual({ _tag: "received", body: null });
  });

  it.each([answer(null), answer(502, "Bad Gateway"), answer(503, null), answer(504, null)])(
    "calls nothing answered and a gateway's status no answer (%j)",
    (gateway) => {
      expect(readReceiveAnswer(gateway)).toEqual({ _tag: "noAnswer", answer: gateway });
    },
  );

  it("calls an untagged 404 and a 413 on bodyBytes an old server", () => {
    expect(readReceiveAnswer(routerNotFound)).toEqual({ _tag: "oldServer" });
    expect(
      readReceiveAnswer(answer(413, { _tag: "BudgetExceeded", budget: "bodyBytes", limit: 9 })),
    ).toEqual({ _tag: "oldServer" });
    expect(readReceiveAnswer(answer(413, { budget: "bodyBytes" }))).toEqual({ _tag: "oldServer" });
  });

  it("reads the limit of a 413 on bundleBytes, tagged or not", () => {
    expect(
      readReceiveAnswer(answer(413, { _tag: "BudgetExceeded", budget: "bundleBytes", limit: 64 })),
    ).toEqual({ _tag: "tooLarge", limit: 64 });
    expect(readReceiveAnswer(answer(413, { budget: "bundleBytes", limit: 64 }))).toEqual({
      _tag: "tooLarge",
      limit: 64,
    });
  });

  it.each([
    [answer(413, "<html>Request Entity Too Large</html>")],
    [answer(413, null)],
    [answer(413, { budget: "bundleBytes", limit: "64" })],
  ])("calls an untagged 413 a refusal in front of Mend (%j)", (proxy) => {
    expect(readReceiveAnswer(proxy)).toEqual({ _tag: "proxyRefused" });
  });

  it.each([
    answer(413, { _tag: "BudgetExceeded", budget: "requests", limit: 5 }),
    answer(413, { _tag: "BudgetExceeded", budget: "bundleBytes" }),
    projectNotFound,
    answer(422, { _tag: "HandoffRefused", message: "no such base" }),
    answer(429, { _tag: "BudgetExceeded", budget: "requests" }),
    answer(401, null),
    answer(500, null),
    answer(304, null),
  ])("passes Mend's own refusals back as refused (%j)", (refused) => {
    expect(readReceiveAnswer(refused)).toEqual({ _tag: "refused", answer: refused });
  });
});

describe("takesHandoffs", () => {
  it("is false for the router's untagged 404", () => {
    expect(takesHandoffs(routerNotFound)).toBe(false);
  });

  it("is true for a tagged 404 or a 200", () => {
    expect(takesHandoffs(projectNotFound)).toBe(true);
    expect(takesHandoffs(answer(200, { bundleBytes: 64, fileBytes: 8 }))).toBe(true);
  });

  it.each([answer(null), answer(401, null), answer(503, null)])(
    "is null when the answer says neither (%j)",
    (neither) => {
      expect(takesHandoffs(neither)).toBeNull();
    },
  );
});
