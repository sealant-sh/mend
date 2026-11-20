import { Sha } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ObservedCheck } from "./checks.ts";
import {
  baseWords,
  checkWords,
  controlRow,
  landingLine,
  landingLineFailed,
  layoutFallbackLine,
  withoutLayoutWords,
  pullRequestOf,
  repositoryRows,
  sessionByline,
  sharedControlWords,
  sharedWithWords,
  untestedWords,
  workspaceServiceRows,
} from "./session-details.ts";

const now = new Date("2026-11-18T12:00:00Z");
const names = (id: string) => (id === "ada" ? "Ada Lovelace" : null);

const check = (result: ObservedCheck["result"], exitCode: number | null): ObservedCheck => ({
  command: "pnpm test",
  kind: "tests",
  result,
  exitCode,
  durationMs: null,
  at: "2026-11-18T11:56:00Z",
});

const view = (
  sessionId: string,
  exitedAt: Date | null,
  forward: { readonly id: string; readonly state: "binding" | "bound" | "closed" } | null,
  observed: "reachable" | "unreachable" | null,
) => ({
  service: {
    id: `svc-${sessionId}`,
    sessionId,
    name: "web",
    workspacePort: 3000,
    currentAttemptId: "p-1",
  },
  attempts: [{ id: "p-1", exitedAt }],
  currentForward: forward,
  latestObservation:
    observed === null || forward === null ? null : { forwardId: forward.id, state: observed },
});

describe("the Workspace group", () => {
  it("names the base branch and its commit, or the commit alone", () => {
    expect(baseWords({ baseRef: "main", baseSha: "9c41e07aa1b2c3d4e5f6" })).toBe("main · 9c41e07");
    expect(baseWords({ baseRef: null, baseSha: "9c41e07aa1b2c3d4e5f6" })).toBe("9c41e07aa1b2");
  });

  it("counts the other sessions in the workspace", () => {
    expect(sharedWithWords(1)).toBeNull();
    expect(sharedWithWords(2)).toBe("Shared with 1 other session");
    expect(sharedWithWords(4)).toBe("Shared with 3 other sessions");
  });

  it("finds the change's newest pull request among its landings", () => {
    const pullRequest = (number: number, state: "open" | "closed" | "merged") => ({
      number,
      url: `https://github.com/acme/checkout/pull/${number}`,
      state,
      title: null,
      observedAt: now,
    });
    expect(pullRequestOf([])).toBeNull();
    expect(pullRequestOf([{ pullRequest: null }])).toBeNull();
    expect(
      pullRequestOf([
        { pullRequest: null },
        { pullRequest: pullRequest(412, "merged") },
        { pullRequest: pullRequest(400, "closed") },
      ]),
    ).toEqual({
      number: 412,
      url: "https://github.com/acme/checkout/pull/412",
      state: "merged",
      words: "Pull request #412 merged",
    });
  });

  it("says the latest landing fact, a turn that didn't land before a push", () => {
    const pushed = { _tag: "pushed", branch: "mend/fix", sha: Sha.make("4f2a91c0ffee") } as const;
    expect(landingLine([], now)).toBeNull();
    expect(landingLine([pushed], now)).toBe("pushed · mend/fix · 4f2a91c · observed");
    expect(landingLine([pushed, { _tag: "not-landed", reason: "off" }], now)).toBe(
      "changes not landed · automatic landing is off",
    );
    expect(landingLineFailed([pushed])).toBe(false);
    expect(landingLineFailed([pushed, { _tag: "failed", message: "no remote" }])).toBe(true);
  });

  it("finds why the workspace takes one person in the session's summary", () => {
    expect(layoutFallbackLine(null)).toBeNull();
    expect(layoutFallbackLine("a secret file was left out")).toBeNull();
    expect(
      layoutFallbackLine(
        "a secret file was left out · this image cannot run per-person users (no sudo), so this workspace takes one person",
      ),
    ).toBe("This image cannot run per-person users (no sudo), so this workspace takes one person.");
  });
});

describe("Sessions in this workspace", () => {
  const session = {
    ownerUserId: "ada",
    harness: "claude",
    model: "opus",
    effort: "high",
    status: "running",
  } as const;

  it("names the owner, the agent with its model and effort, and the status", () => {
    expect(sessionByline(session, "grace", names)).toBe(
      "Ada Lovelace · Claude Code, opus, high effort · Running",
    );
    expect(sessionByline({ ...session, ownerUserId: "grace" }, "grace", names)).toBe(
      "You · Claude Code, opus, high effort · Running",
    );
  });

  it("goes without the model until it is read, and names an owner it can't as another member", () => {
    expect(
      sessionByline(
        { ownerUserId: "someone", harness: "codex", status: "waiting" },
        "grace",
        names,
      ),
    ).toBe("Another member · Codex · Waiting on you");
    expect(
      sessionByline(
        { ...session, ownerUserId: null, model: null, effort: null, status: "completed" },
        "grace",
        names,
      ),
    ).toBe("No owner · Claude Code · Completed");
  });

  it("says whether each session's shared control is on, and who holds it one by one", () => {
    const off = { ownerUserId: "ada", sharedControlEnabledAt: null };
    expect(sharedControlWords(off, "grace", names)).toBe("Shared control is off.");
    expect(sharedControlWords({ ...off, sharedControlEnabledAt: now }, "grace", names)).toBe(
      "Shared control is on: everyone who can see this project can steer it.",
    );
    expect(
      sharedControlWords({ ownerUserId: null, sharedControlEnabledAt: null }, "grace", names),
    ).toBe("No owner, so nobody steers it.");
    expect(sharedControlWords({ ...off, sharedControlUserIds: ["ada"] }, "grace", names)).toBe(
      "Ada Lovelace has shared control.",
    );
    expect(
      sharedControlWords({ ...off, sharedControlUserIds: ["alan", "grace"] }, "grace", names),
    ).toBe("You and another member have shared control.");
  });
});

describe("shared control of the page's session", () => {
  const off = { ownerUserId: "ada", sharedControlEnabledAt: null };
  const on = { ownerUserId: "ada", sharedControlEnabledAt: now };
  const owner = { own: true, toggleSharedControl: true };
  const member = { own: false, toggleSharedControl: false };
  const organizationOwner = { own: false, toggleSharedControl: true };
  const grace = { id: "grace", nameOf: names };
  const stranger = { id: "grace", nameOf: () => null };

  it("gives the owner the switch, on or off", () => {
    expect(controlRow(off, owner, grace)).toEqual({ kind: "owner", on: false });
    expect(controlRow(on, owner, grace)).toEqual({ kind: "owner", on: true });
  });

  it("tells everyone else who steers", () => {
    expect(controlRow(off, member, grace)).toEqual({
      kind: "line",
      line: "Only Ada Lovelace steers this session. You can read the record and review the change.",
    });
    expect(controlRow(on, member, grace)).toEqual({
      kind: "line",
      line: "Ada Lovelace shares control of this session. Everyone who can see this project can steer it.",
    });
  });

  it("says its owner when the roster doesn't name them", () => {
    expect(controlRow(off, member, stranger)).toEqual({
      kind: "line",
      line: "Only its owner steers this session. You can read the record and review the change.",
    });
    expect(controlRow(on, member, stranger)).toEqual({
      kind: "line",
      line: "Its owner shares control of this session. Everyone who can see this project can steer it.",
    });
  });

  it("names who else holds a grant, and tells a person who holds one", () => {
    expect(controlRow({ ...off, sharedControlUserIds: ["alan"] }, member, grace)).toEqual({
      kind: "line",
      line: "Only Ada Lovelace and another member steer this session. You can read the record and review the change.",
    });
    expect(controlRow({ ...off, sharedControlUserIds: ["grace"] }, member, grace)).toEqual({
      kind: "line",
      line: "Ada Lovelace shares control of this session with you.",
    });
  });

  it("lets an organization owner turn it off, and only while it is on", () => {
    expect(controlRow(on, organizationOwner, grace).kind).toBe("can-turn-off");
    expect(controlRow(off, organizationOwner, grace).kind).toBe("line");
  });
});

describe("the Checks group", () => {
  it("says how each check ended and when, never more than the record holds", () => {
    expect(checkWords(check("passed", 0), now)).toBe("Passed 4 min ago.");
    expect(checkWords(check("failed", 1), now)).toBe("Failed 4 min ago, exit code 1.");
    expect(checkWords(check("failed", null), now)).toBe("Failed 4 min ago.");
    expect(checkWords(check("running", null), now)).toBe("Running now.");
    expect(checkWords(check("unknown", null), now)).toBe(
      "Ran 4 min ago. The record holds no exit code.",
    );
  });

  it("counts the edits made after the newest check", () => {
    const edits = [
      { at: "2026-11-18T11:50:00Z" },
      { at: "2026-11-18T11:57:00Z" },
      { at: "2026-11-18T11:58:00Z" },
    ];
    expect(untestedWords(edits, [check("passed", 0)])).toBe(
      "The last 2 edits haven't been tested.",
    );
    expect(untestedWords(edits.slice(0, 2), [check("passed", 0)])).toBe(
      "The last edit hasn't been tested.",
    );
    expect(untestedWords(edits.slice(0, 1), [check("passed", 0)])).toBeNull();
    // No check ran, or one is still running: nothing to say about what it covers.
    expect(untestedWords(edits, [])).toBeNull();
    expect(untestedWords(edits, [check("running", null)])).toBeNull();
  });
});

describe("the Services group", () => {
  it("lists the workspace's running Services with what was observed of their port", () => {
    const rows = workspaceServiceRows(
      [
        view("s-1", null, { id: "f-1", state: "bound" }, "reachable"),
        view("s-2", null, { id: "f-2", state: "binding" }, null),
        view("s-3", null, { id: "f-3", state: "bound" }, "unreachable"),
        view("other", null, { id: "f-4", state: "bound" }, "reachable"),
        view("s-4", new Date(), null, null),
      ],
      new Set(["s-1", "s-2", "s-3", "s-4"]),
    );
    expect(rows.map((row) => [row.id, row.name, row.state])).toEqual([
      ["svc-s-1", "web :3000", "Running"],
      ["svc-s-2", "web :3000", "Running. Its port hasn't answered yet."],
      ["svc-s-3", "web :3000", "Running. Its port doesn't answer."],
    ]);
  });
});

describe("the Repositories group", () => {
  it("says each repository's project, branch and how far it moved", () => {
    const repository = {
      path: "vendor/payments",
      branch: "mend/fix",
      error: null,
      capture: "own",
      state: "ready",
    } as const;
    expect(
      repositoryRows([
        { repository, projectName: "payments", checkpointsBeyondStart: 2, change: { id: "c-1" } },
        {
          repository: { ...repository, path: "docs", capture: "nested" },
          projectName: null,
          checkpointsBeyondStart: 0,
          change: null,
        },
        {
          repository: { ...repository, path: "infra", state: "failed", error: "clone failed" },
          projectName: "infra",
          checkpointsBeyondStart: 0,
          change: { id: "c-3" },
        },
      ]),
    ).toEqual([
      {
        path: "vendor/payments",
        line: "payments · mend/fix · 2 checkpoints beyond start",
        failed: false,
        changeId: "c-1",
      },
      {
        path: "docs",
        line: "project removed · mend/fix · saved with the main repository",
        failed: false,
        changeId: null,
      },
      { path: "infra", line: "infra · mend/fix · clone failed", failed: true, changeId: null },
    ]);
  });
});

describe("the conversation's summary", () => {
  it("leaves out why the workspace takes one person, which the Details view says", () => {
    expect(
      withoutLayoutWords(
        "secret file .env not written · this image cannot run per-person users (no sudo), so this workspace takes one person",
      ),
    ).toBe("secret file .env not written");
    expect(
      withoutLayoutWords("a standby workspace serves this session, and a standby takes one person"),
    ).toBeNull();
    expect(withoutLayoutWords(null)).toBeNull();
  });
});
