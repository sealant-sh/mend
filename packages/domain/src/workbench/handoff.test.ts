import { Result, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Sha } from "../ids.ts";
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
  WorktreeHandoff,
} from "./handoff.ts";
import { WorktreeName } from "./worktree.ts";

const TIP = "3e73da3c0ffee0000000000000000000000000ab";
const HEAD = Sha.make("9c1e2f3aa000000000000000000000000000000b");

const trailers = (localBranch: string | null): HandoffTrailers => ({
  machine: HandoffMachine.make("dana-mbp"),
  localBranch: localBranch === null ? null : HandoffBranch.make(localBranch),
  cutAt: HandoffCutAt.make("2026-10-18T07:42:05.000Z"),
  defaultTip: HexSha.make(TIP),
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
        fc.date({ min: new Date(0), max: new Date("2100-01-01"), noInvalidDate: true }),
        fc.stringMatching(/^[0-9a-f]{64}$/),
        (machine, branch, cut, tip) => {
          const value: HandoffTrailers = {
            machine: HandoffMachine.make(machine),
            localBranch: branch === null ? null : HandoffBranch.make(branch),
            cutAt: HandoffCutAt.make(cut.toISOString()),
            defaultTip: HexSha.make(tip),
          };
          expect(parseHandoffMessage(formatHandoffMessage(value))).toEqual(Result.succeed(value));
        },
      ),
    );
  });

  it("accepts the trailers in any order and without the final newline", () => {
    expect(
      faultOf(
        `mend handoff\n\nMend-Default-Tip: ${TIP}\nMend-Cut-At: 2026-10-18T07:42:05.000Z\nMend-Machine: m`,
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
    );
    expect(parseHandoffMessage(text)).toEqual(
      Result.fail({ reason: "duplicate-trailer", detail: "Mend-Machine appears more than once" }),
    );
    expect(
      faultOf(
        message(
          "Mend-Machine: a",
          "Mend-Branch: x",
          "Mend-Branch: x",
          "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
          `Mend-Default-Tip: ${TIP}`,
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
  });

  it("refuses garbled lines and values", () => {
    const valid = {
      machine: "Mend-Machine: a",
      cutAt: "Mend-Cut-At: 2026-10-18T07:42:05.000Z",
      tip: `Mend-Default-Tip: ${TIP}`,
    };
    const garbled = [
      message(valid.machine, valid.cutAt, valid.tip, "Signed-off-by: someone"),
      message(valid.machine, valid.cutAt, valid.tip, "Mend-Branch:fix"),
      message(valid.machine, valid.cutAt, valid.tip, ""),
      message(valid.machine, valid.cutAt, "Mend-Default-Tip: 3E73DA3"),
      message(valid.machine, valid.cutAt, `Mend-Default-Tip: ${TIP.toUpperCase()}`),
      message(valid.machine, "Mend-Cut-At: 2026-10-18T07:42:05Z", valid.tip),
      message(valid.machine, "Mend-Cut-At: 2026-10-18T10:42:05+03:00", valid.tip),
      message(valid.machine, "Mend-Cut-At: yesterday", valid.tip),
      message(`Mend-Machine: ${"m".repeat(65)}`, valid.cutAt, valid.tip),
      message("Mend-Machine:  padded", valid.cutAt, valid.tip),
      message("Mend-Machine: tab\there", valid.cutAt, valid.tip),
      message(valid.machine, "Mend-Branch: fix\r", valid.cutAt, valid.tip),
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
    deltaPack: "packs/pack-0123.pack",
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
    expect(Schema.is(WorktreeHandoff)({ ...row, deltaPack: "" })).toBe(false);
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
  const counts = { commitsAhead: 2, uncommitted: 3, untracked: 1, defaultBranch: "main" };

  it("names commits, uncommitted and untracked files", () => {
    expect(formatFactLine(counts)).toBe(
      "2 commits ahead of main · 3 uncommitted files · 1 untracked",
    );
  });

  it("says one in the singular", () => {
    expect(formatFactLine({ ...counts, commitsAhead: 1, uncommitted: 1, untracked: 0 })).toBe(
      "1 commit ahead of main · 1 uncommitted file",
    );
  });

  it("says even and none for zero, and leaves zero untracked out", () => {
    expect(
      formatFactLine({ commitsAhead: 0, uncommitted: 0, untracked: 0, defaultBranch: "trunk" }),
    ).toBe("even with trunk · no uncommitted files");
    expect(formatFactLine({ ...counts, commitsAhead: 0, uncommitted: 0, untracked: 4 })).toBe(
      "even with main · no uncommitted files · 4 untracked",
    );
  });
});
