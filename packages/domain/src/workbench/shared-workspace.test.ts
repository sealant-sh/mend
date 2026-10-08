import { describe, expect, it } from "vitest";

import {
  PreReleaseMemory,
  WorkspaceRetirement,
  WorkspaceRetirementStop,
} from "./harness-layout.ts";
import {
  joinWorktreeLine,
  preReleaseMemoryLine,
  retirementStopLines,
  SHARED_CONTROL_LINE,
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
      canReplace: true,
    });
    expect(workspaceRetirementLine(retirement, "Anna")).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced · not replaced · 1 shell",
    );
    expect(retirementStopLines(retirement)).toEqual([
      "shell · auth · shell 1",
      "mend.toml Services start again.",
    ]);
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

  it("says beside Shared control whose login a steered turn runs on", () => {
    expect(sharedControlLine(true)).toBe(SHARED_CONTROL_LINE);
    expect(sharedControlLine(false)).toBe(
      "Each turn runs on your provider logins and Git access, whoever sends it.",
    );
  });
});
