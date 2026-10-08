import { WorktreeId } from "@mend/domain";
import {
  joinWorktreeLine,
  SHARED_CONTROL_LINE,
  SHARED_CONTROL_LINE_OWNER_LOGINS,
  sharedControlLine,
  WorkspaceRetirement,
  WorkspaceRetirementStop,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  replaceRefusalWords,
  retirementView,
  sharedControlClick,
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
    ],
    reason: null,
    canReplace: true,
    ...fields,
  });

describe("the retirement view", () => {
  it("names the launcher and lists what would stop for the change's owner", () => {
    const view = retirementView(retirement(), names, []);
    expect(view.line).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Alice's sessions and turns until it is replaced",
    );
    expect(view.stops).toEqual([
      "terminal session (ends resumable) · claude — fix login",
      "Service started by hand · web on :3000",
      "mend.toml Services start again.",
    ]);
    expect(view.canReplace).toBe(true);
  });

  it("offers nothing to someone who cannot replace it, or while it is being replaced", () => {
    const reader = retirementView(retirement({ canReplace: false }), names, []);
    expect(reader.canReplace).toBe(false);
    expect(reader.stops).toEqual([]);
    const retiring = retirementView(retirement({ state: "retiring" }), names, []);
    expect(retiring.canReplace).toBe(false);
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

describe("a refused replacement", () => {
  it("shows the server's words without the web tier's tag", () => {
    const words = "An agent's turn is in flight; it is never stopped. Try again once it completes.";
    expect(replaceRefusalWords(new Error(`WorkspaceReplaceRefused: ${words}`))).toBe(words);
    expect(replaceRefusalWords(new Error("mend api unreachable"))).toBe("mend api unreachable");
    expect(replaceRefusalWords(new Error(""))).toBe("The workspace was not replaced.");
  });
});

describe("the Shared control switch", () => {
  it("asks before turning on only where each turn runs on its sender's login", () => {
    expect(sharedControlClick(true, true)).toBe("confirm");
    expect(sharedControlClick(true, false)).toBe("toggle");
    expect(sharedControlClick(false, true)).toBe("toggle");
    expect(sharedControlClick(false, false)).toBe("toggle");
  });

  it("says whose logins a steered turn runs on", () => {
    expect(sharedControlLine(true)).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlLine(false)).toBe(SHARED_CONTROL_LINE_OWNER_LOGINS);
  });
});
