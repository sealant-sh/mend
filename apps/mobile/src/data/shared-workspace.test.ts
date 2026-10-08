import { describe, expect, it } from "vitest";

import {
  retirementViewOf,
  sharedWorkspaceLineOf,
  type WorkspaceRetirementDto,
} from "./shared-workspace";

const retirement = (patch: Partial<WorkspaceRetirementDto> = {}): WorkspaceRetirementDto => ({
  state: "marked",
  preRelease: true,
  launcher: "anna",
  stops: [{ kind: "terminal", label: "fix-auth" }],
  reason: null,
  canReplace: true,
  ...patch,
});

describe("the shared-workspace line (docs/adr/0016, decision 13)", () => {
  it("names the others live in the executor, for whoever reads it", () => {
    expect(
      sharedWorkspaceLineOf(
        [
          { accountId: "anna", name: "Anna" },
          { accountId: "bob", name: "Bob" },
        ],
        "anna",
      ),
    ).toBe(
      "Shared workspace with Bob · each of you runs as yourself · either of you can read the other's files.",
    );
  });

  it("says nothing with one person live, or from an older server", () => {
    expect(sharedWorkspaceLineOf([{ accountId: "anna", name: "Anna" }], "anna")).toBeNull();
    expect(sharedWorkspaceLineOf(undefined, null)).toBeNull();
  });
});

describe("the retirement line (docs/adr/0016, decision 14)", () => {
  const names = new Map([["anna", "Anna"]]);

  it("says whose sessions it takes, and what would stop for the change's owner", () => {
    const view = retirementViewOf(retirement(), names);
    expect(view?.line).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Anna's sessions and turns until it is replaced",
    );
    expect(view?.stops).toEqual([
      "terminal session (ends resumable) · fix-auth",
      "mend.toml Services start again.",
    ]);
  });

  it("says why the last replacement did not go ahead, and lists nothing for someone else", () => {
    const view = retirementViewOf(
      retirement({ canReplace: false, preRelease: false, reason: "a shell is open" }),
      names,
    );
    expect(view?.line).toBe(
      "This workspace shares one home · it takes only Anna's sessions and turns until it is replaced · a shell is open",
    );
    expect(view?.stops).toEqual([]);
  });

  it("is said while the workspace is being replaced, and is absent otherwise", () => {
    expect(retirementViewOf(retirement({ state: "retiring" }), names)?.line).toBe(
      "Replacing this workspace so that each person runs as themselves · nothing new starts until it has been saved and replaced",
    );
    expect(retirementViewOf(null, names)).toBeNull();
  });
});
