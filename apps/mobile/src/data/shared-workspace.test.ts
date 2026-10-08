import { describe, expect, it } from "vitest";

import {
  keyedLines,
  readsRetirement,
  readsWaiting,
  replaceConfirmationOf,
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
  checkedAt: "2026-10-08T12:05:41.000Z",
  fingerprint: "fp-1",
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
      "Checked at 12:05 UTC: Mend's records, the processes in the workspace and its running containers",
      "terminal session (ends resumable) · fix-auth",
      "Mend starts the launching session's mend.toml Services again.",
    ]);
    expect(view?.seen).toBe("fp-1");
  });

  it("says when only Mend's records were read, and a kind alone where the label is not the viewer's", () => {
    const view = retirementViewOf(
      retirement({
        checkedAt: null,
        stops: [
          { kind: "container", label: "" },
          { kind: "unchecked", label: "" },
        ],
      }),
      names,
    );
    expect(view?.stops).toEqual([
      "Checked: Mend's records only · processes Mend did not start and running containers not checked yet",
      "running container",
      "could not check",
      "Mend starts the launching session's mend.toml Services again.",
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

describe("Replace this workspace now (docs/adr/0016, decision 14)", () => {
  it("asks with what would stop, and sends the fingerprint of the same read", () => {
    const view = retirementViewOf(retirement({ fingerprint: "fp-shown" }), new Map());
    if (view === null) throw new Error("no retirement view");
    const ask = replaceConfirmationOf(view);
    expect(ask.title).toBe("Replace this workspace now?");
    expect(ask.message.split("\n")).toEqual(view.stops);
    expect(ask.body).toEqual({ seen: "fp-shown" });
  });
});

describe("the reads behind the lines", () => {
  const anna = { accountId: "anna", name: "Anna" };
  const shared = "2026-10-08T12:00:00.000Z";

  it("reads the waiting line only while someone is live in the executor and control is shared", () => {
    expect(readsWaiting({ livePeople: [anna], sharedControlEnabledAt: shared })).toBe(true);
    expect(readsWaiting({ livePeople: [], sharedControlEnabledAt: shared })).toBe(false);
    expect(readsWaiting({ livePeople: [anna], sharedControlEnabledAt: null })).toBe(false);
    // An older server says neither.
    expect(readsWaiting({})).toBe(false);
    expect(readsWaiting(undefined)).toBe(false);
  });

  it("reads the retirement only while the session's view says its executor waits to be replaced", () => {
    expect(readsRetirement({ workspaceRetirement: "marked" })).toBe(true);
    expect(readsRetirement({ workspaceRetirement: "retiring" })).toBe(true);
    expect(readsRetirement({ workspaceRetirement: null })).toBe(false);
    expect(readsRetirement({})).toBe(false);
    expect(readsRetirement(undefined)).toBe(false);
  });
});

describe("the stop lines' keys", () => {
  it("stay unique when two lines read alike", () => {
    expect(keyedLines(["running container", "running container"]).map((row) => row.key)).toEqual([
      "running container#1",
      "running container#2",
    ]);
  });
});
