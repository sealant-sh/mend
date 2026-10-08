import { describe, expect, it } from "vitest";

import {
  PreReleaseMemory,
  WorkspaceRetirement,
  WorkspaceRetirementStop,
} from "./harness-layout.ts";
import {
  JOIN_SHARED_HOME_LINE,
  joinWorktreeLine,
  preReleaseMemoryLine,
  retirementStopLines,
  SHARED_CONTROL_LINE,
  sharedControlConfirm,
  sharedControlLine,
  sharedWorkspaceLine,
  workspaceRetirementLine,
} from "./shared-workspace.ts";

const anna = { accountId: "anna", name: "Anna" };
const bob = { accountId: "bob", name: "Bob" };
const cleo = { accountId: "cleo", name: "Cleo" };

describe("what the product says about a shared workspace (docs/adr/0016, decision 13)", () => {
  it("says the join line word for word where two people meet", () => {
    expect(joinWorktreeLine(["Anna"])).toBe(
      "Anna's session is running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but either of you can read the other's files, logins included.",
    );
    expect(joinWorktreeLine(["Anna", "Cleo"])).toContain("Anna and Cleo's sessions are running");
    // A workspace that shares one home: the joiner runs on whoever started it, not as themselves.
    expect(JOIN_SHARED_HOME_LINE).toBe(
      "Another person's session is running in this worktree, in a workspace that shares one home: what you start there runs on the logins and Git identity of whoever started that workspace, not yours.",
    );
    // A workspace that shares one home: the joiner runs on whoever started it, not as themselves.
    expect(JOIN_SHARED_HOME_LINE).toBe(
      "Another person's session is running in this worktree, in a workspace that shares one home: what you start there runs on the logins and Git identity of whoever started that workspace, not yours.",
    );
  });

  it("names the others on a session while someone else's process is live", () => {
    expect(sharedWorkspaceLine([anna, bob], "bob")).toBe(
      "Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.",
    );
    expect(sharedWorkspaceLine([anna, bob, cleo], "bob")).toBe(
      "Shared workspace with Anna and Cleo · each of you runs as yourself · any of you can read the others' files.",
    );
    expect(sharedWorkspaceLine([anna, bob], "cleo")).toBe(
      "Shared workspace: Anna and Bob · each runs as themselves · either can read the other's files.",
    );
  });

  it("says nothing with one person live, or none", () => {
    expect(sharedWorkspaceLine([anna], "anna")).toBeNull();
    expect(sharedWorkspaceLine([], "anna")).toBeNull();
  });

  it("says what a retiring workspace takes and what would stop", () => {
    const retirement = new WorkspaceRetirement({
      state: "marked",
      preRelease: true,
      launcher: "anna",
      stops: [new WorkspaceRetirementStop({ kind: "shell", label: "auth · shell 1" })],
      reason: "not replaced · 1 shell",
      checkedAt: new Date("2026-10-08T12:05:00Z"),
      fingerprint: "f1",
      canReplace: true,
    });
    expect(workspaceRetirementLine(retirement, "Anna")).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced · not replaced · 1 shell",
    );
    expect(retirementStopLines(retirement)).toEqual([
      "Checked at 12:05 UTC: Mend's records, the processes in the workspace and its running containers",
      "shell · auth · shell 1",
      "Mend starts the launching session's mend.toml Services again.",
    ]);
    // Never "nothing would stop": what was checked, and what was found.
    expect(retirementStopLines({ stops: [], checkedAt: null })).toEqual([
      "Checked: Mend's records only · processes Mend did not start and running containers not checked yet",
      "Found nothing that would stop.",
      "Mend starts the launching session's mend.toml Services again.",
    ]);
    // Anyone but the change's owner reads a process's kind, not its name.
    expect(
      retirementStopLines({
        stops: [new WorkspaceRetirementStop({ kind: "process", label: "" })],
        checkedAt: null,
      })[1],
    ).toBe("process Mend did not start");
  });

  it("lists memory credited to nobody on the worktree", () => {
    const memory = new PreReleaseMemory({
      captureN: 4,
      provisional: false,
      creditedTo: null,
      decidedBy: "nobody",
      notCredited: [".claude/projects/-workspace-repo/memory/MEMORY.md"],
    });
    expect(preReleaseMemoryLine(memory)).toBe("memory from before 0.36, not credited · 1 file");
    expect(preReleaseMemoryLine(null)).toBeNull();
  });

  it("confirms in both layouts, in words true to each", () => {
    expect(sharedControlConfirm(true).body).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlConfirm(false)).toEqual({
      title: "Turn on shared control?",
      body: "Everyone who can see this project can send turns, answer approvals and interrupt. Each turn runs on your provider logins and Git access, whoever sends it.",
      confirm: "Turn on",
      cancel: "Keep it off",
    });
  });

  it("says beside Shared control whose login a steered turn runs on", () => {
    expect(sharedControlLine(true)).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlLine(false)).toBe(
      "Each turn runs on your provider logins and Git access, whoever sends it.",
    );
  });
});
