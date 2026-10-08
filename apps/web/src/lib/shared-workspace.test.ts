import { WorktreeId } from "@mend/domain";
import {
  joinWorktreeLine,
  retirementStopLines,
  SHARED_CONTROL_LINE,
  SHARED_CONTROL_LINE_OWNER_LOGINS,
  sharedControlConfirm,
  sharedControlLine,
  WorkspaceRetirement,
  WorkspaceRetirementStop,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  canEndWaitingWork,
  replaceRefusalWords,
  replaceWorkspaceBody,
  retirementRelevant,
  retirementView,
  sharedControlClick,
  WAIT_POLL_MS,
  waitingLineQuery,
  waitingLineRelevant,
  worktreeJoinLine,
  worktreeOthers,
} from "./shared-workspace.ts";

const here = WorktreeId.make("worktree-1");
const elsewhere = WorktreeId.make("worktree-2");
const names = new Map([
  ["alice", "Alice"],
  ["bob", "Bob"],
  ["carol", "Carol"],
]);

type Row = Parameters<typeof worktreeOthers>[0][number];
const row = (
  ownerUserId: string | null,
  status: Row["status"] = "running",
  worktreeId: Row["worktreeId"] = here,
  livePeople: Row["livePeople"] = [],
): Row => ({ worktreeId, ownerUserId, status, livePeople });

describe("the join line", () => {
  it("names the people whose live sessions run in the chosen worktree, never the viewer", () => {
    const sessions = [row("alice"), row("bob"), row("alice", "idle")];
    expect(worktreeJoinLine(sessions, here, "bob", names)).toBe(joinWorktreeLine(["Alice"]));
    expect(worktreeJoinLine(sessions, here, "carol", names)).toBe(
      joinWorktreeLine(["Alice", "Bob"]),
    );
  });

  it("says nothing for the viewer's own sessions, settled ones, another worktree, or no viewer", () => {
    expect(worktreeJoinLine([row("bob")], here, "bob", names)).toBeNull();
    expect(worktreeJoinLine([row("alice", "completed")], here, "bob", names)).toBeNull();
    expect(worktreeJoinLine([row("alice", "running", elsewhere)], here, "bob", names)).toBeNull();
    expect(worktreeJoinLine([row("alice")], here, null, names)).toBeNull();
  });

  it("counts the people the session view lists as live in the executor", () => {
    const steered = row("bob", "running", here, [
      { accountId: "bob", name: "Bob" },
      { accountId: "dana", name: "Dana" },
    ]);
    expect(worktreeOthers([steered], here, "bob", names)).toEqual({ count: 1, names: ["Dana"] });
    expect(worktreeJoinLine([steered], here, "carol", names)).toBe(
      joinWorktreeLine(["Bob", "Dana"]),
    );
  });

  it("says another person when the roster does not name everyone", () => {
    expect(worktreeJoinLine([row("erin"), row("alice")], here, "bob", names)).toBe(
      joinWorktreeLine([]),
    );
  });
});

const checkedAt = new Date("2026-10-08T12:05:00Z");

const retirement = (
  fields: Partial<ConstructorParameters<typeof WorkspaceRetirement>[0]> = {},
): WorkspaceRetirement =>
  new WorkspaceRetirement({
    state: "marked",
    preRelease: true,
    launcher: "alice",
    stops: [
      new WorkspaceRetirementStop({ kind: "terminal", label: "claude — fix login" }),
      new WorkspaceRetirementStop({ kind: "service", label: "web on :3000" }),
      new WorkspaceRetirementStop({ kind: "process", label: "python (pid 31)" }),
    ],
    reason: null,
    checkedAt,
    fingerprint: "fp-1",
    canReplace: true,
    ...fields,
  });

describe("the retirement view", () => {
  it("names the launcher and lists, as evidence, what was checked and what would stop", () => {
    const view = retirementView(retirement(), names, []);
    expect(view.line).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Alice's sessions and turns until it is replaced",
    );
    expect(view.stops).toEqual(retirementStopLines(retirement()));
    expect(view.stops[0]).toContain("Checked at 12:05 UTC");
    expect(view.stops).toContain("process Mend did not start · python (pid 31)");
    expect(view.canReplace).toBe(true);
  });

  it("shows everyone else the evidence, with a process's kind only, and no action", () => {
    const reader = retirementView(
      retirement({
        canReplace: false,
        stops: [
          new WorkspaceRetirementStop({ kind: "process", label: "" }),
          new WorkspaceRetirementStop({ kind: "container", label: "" }),
        ],
      }),
      names,
      [],
    );
    expect(reader.canReplace).toBe(false);
    expect(reader.stops).toContain("process Mend did not start");
    expect(reader.stops).toContain("running container");
    expect(reader.stops.join("\n")).not.toContain("pid");
  });

  it("offers nothing while it is being replaced", () => {
    const retiring = retirementView(retirement({ state: "retiring" }), names, []);
    expect(retiring.canReplace).toBe(false);
    expect(retiring.stops).toEqual([]);
    expect(retiring.line).toContain("Replacing this workspace");
  });

  it("takes the launcher's name from the live people when the roster lacks it", () => {
    const view = retirementView(
      retirement({ launcher: "erin", reason: "a shell is open" }),
      names,
      [{ accountId: "erin", name: "Erin" }],
    );
    expect(view.line).toContain("Erin's sessions");
    expect(view.line.endsWith(" · a shell is open")).toBe(true);
  });
});

describe("a replacement", () => {
  it("names the retirement the owner was shown", () => {
    expect(replaceWorkspaceBody(retirement({ fingerprint: "fp-42" }))).toEqual({ seen: "fp-42" });
  });

  it("shows a refusal in the server's words without the web tier's tag", () => {
    const words =
      "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.";
    expect(replaceRefusalWords(new Error(`WorkspaceReplaceRefused: ${words}`))).toBe(words);
    expect(replaceRefusalWords(new Error("mend api unreachable"))).toBe("mend api unreachable");
    expect(replaceRefusalWords(new Error(""))).toBe("The workspace was not replaced.");
  });
});

describe("what the session page asks for", () => {
  const alice = { accountId: "alice", name: "Alice" };
  const on = new Date("2026-10-08T09:00:00Z");

  it("asks for the waiting line only where people run and control is shared", () => {
    expect(waitingLineRelevant({ livePeople: [alice], sharedControlEnabledAt: on })).toBe(true);
    expect(waitingLineRelevant({ livePeople: [], sharedControlEnabledAt: on })).toBe(false);
    expect(waitingLineRelevant({ livePeople: [alice], sharedControlEnabledAt: null })).toBe(false);
  });

  it("polls the waiting line only while it can show and the session is live", () => {
    expect(waitingLineQuery({ livePeople: [alice], sharedControlEnabledAt: on }, true)).toEqual({
      enabled: true,
      refetchInterval: WAIT_POLL_MS,
    });
    expect(waitingLineQuery({ livePeople: [alice], sharedControlEnabledAt: on }, false)).toEqual({
      enabled: true,
      refetchInterval: false,
    });
    // With the flag off (nobody listed) or control not shared: nothing at all.
    expect(waitingLineQuery({ livePeople: [], sharedControlEnabledAt: on }, true)).toEqual({
      enabled: false,
      refetchInterval: false,
    });
    expect(waitingLineQuery({ livePeople: [alice], sharedControlEnabledAt: null }, true)).toEqual({
      enabled: false,
      refetchInterval: false,
    });
  });

  it("asks for the retirement only when the session says one is under way", () => {
    expect(retirementRelevant({ workspaceRetirement: null })).toBe(false);
    expect(retirementRelevant({ workspaceRetirement: "marked" })).toBe(true);
    expect(retirementRelevant({ workspaceRetirement: "retiring" })).toBe(true);
  });
});

const waitFacts = (viewerId: string | null, steer: boolean) => ({
  viewerId,
  ownerUserId: "alice",
  runsAs: "bob",
  steer,
});

describe("ending the work a turn waits for", () => {
  it("is the session's owner's, whether or not they could steer", () => {
    expect(canEndWaitingWork(waitFacts("alice", true))).toBe(true);
    expect(canEndWaitingWork(waitFacts("alice", false))).toBe(true);
  });

  it("is the person the process runs as only while they can steer", () => {
    expect(canEndWaitingWork(waitFacts("bob", true))).toBe(true);
    expect(canEndWaitingWork(waitFacts("bob", false))).toBe(false);
  });

  it("is nobody else's", () => {
    expect(canEndWaitingWork(waitFacts("carol", true))).toBe(false);
    expect(canEndWaitingWork(waitFacts(null, true))).toBe(false);
  });
});

describe("the Shared control switch", () => {
  it("asks before turning on, in both layouts, and never before turning off", () => {
    expect(sharedControlClick(true)).toBe("confirm");
    expect(sharedControlClick(false)).toBe("toggle");
  });

  it("asks in words true to whose login a steered turn runs on", () => {
    expect(sharedControlConfirm(true).body).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlConfirm(false).body).toContain(SHARED_CONTROL_LINE_OWNER_LOGINS);
    expect(sharedControlConfirm(false).body).not.toContain("sender's login");
  });

  it("says whose logins a steered turn runs on", () => {
    expect(sharedControlLine(true)).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlLine(false)).toBe(SHARED_CONTROL_LINE_OWNER_LOGINS);
  });
});
