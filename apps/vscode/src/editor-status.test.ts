import { describe, expect, it } from "vitest";

import {
  editorIdentity,
  emptyInstallMemory,
  planExtensions,
  type InstallMemory,
  type LocalExtensions,
} from "./editor-extensions.js";
import {
  notInWorkspaceReason,
  settledState,
  statusView,
  type EditorSyncState,
} from "./editor-status.js";

describe("statusView", () => {
  it.each<[EditorSyncState, string | null, string | null]>([
    [{ kind: "inactive" }, null, null],
    [{ kind: "checking" }, "checking extensions", "mend.showWorkspaceEditorLog"],
    [{ kind: "sharedHome" }, "editor stays local · shared home", "mend.showWorkspaceEditorLog"],
    [
      { kind: "noLocalList" },
      "extensions not synced · no local list",
      "mend.showWorkspaceEditorLog",
    ],
    [
      { kind: "installing", current: 12, total: 41 },
      "installing extensions 12/41",
      "mend.showWorkspaceEditorLog",
    ],
    [
      { kind: "inSync", installed: 0, staysLocal: 0 },
      "extensions in sync",
      "mend.showWorkspaceEditorLog",
    ],
    [
      { kind: "notSynced", reason: "2 extensions failed." },
      "extensions not synced · Sync",
      "mend.bringMyEditor",
    ],
  ])("%o → %s", (state, text, command) => {
    const view = statusView(state);
    expect(view?.text ?? null).toBe(text);
    expect(view?.command ?? null).toBe(command);
  });

  it("says what a pass did and why it did not sync", () => {
    expect(statusView({ kind: "inSync", installed: 1, staysLocal: 2 })?.tooltip).toBe(
      "Mend installed 1 extension in this workspace. 2 extensions run in your local window only.",
    );
    expect(statusView({ kind: "inSync", installed: 0, staysLocal: 0 })?.tooltip).toBe(
      "This workspace has your extensions.",
    );
    expect(statusView({ kind: "notSynced", reason: "2 extensions failed." })?.tooltip).toBe(
      "2 extensions failed. Click to try again; the log names each extension.",
    );
  });
});

describe("notInWorkspaceReason", () => {
  it("names the extensions, five at most", () => {
    expect(notInWorkspaceReason(["c.three"])).toBe(
      "1 extension is not in this workspace: c.three.",
    );
    expect(notInWorkspaceReason(["a", "b", "c", "d", "e", "f", "g"])).toBe(
      "7 extensions are not in this workspace: a, b, c, d, e and 2 more.",
    );
  });
});

describe("settledState", () => {
  const EDITOR = editorIdentity("Visual Studio Code", "1.139.1", "d41d8cd9");
  const NOW = 1_792_270_215_287;
  const list: LocalExtensions = {
    version: 1,
    capturedAt: NOW,
    extensions: [
      { id: "a.one", version: "1.0.0", gallery: null },
      {
        id: "c.three",
        version: "1.0.0",
        gallery: { uuid: "u3", extensionsFolder: "/home/me/.vscode/extensions" },
      },
    ],
    fromFile: [],
  };
  const remote = new Map([["a.one", null]]);

  it("a gallery miss remembered within the day plans nothing and settles not synced, naming it", () => {
    const memory: InstallMemory = { ...emptyInstallMemory, missing: { "c.three": NOW - 1_000 } };
    expect(planExtensions(list, remote, memory, EDITOR, NOW)).toEqual({
      install: [],
      recentlyMissing: ["c.three"],
    });
    const state = settledState(list, remote, memory, EDITOR, []);
    expect(state).toEqual({
      kind: "notSynced",
      reason: "1 extension is not in this workspace: c.three.",
    });
    expect(statusView(state)?.text).toBe("extensions not synced · Sync");
  });

  it("counts what a pass installed and what stays local once nothing is absent", () => {
    const memory: InstallMemory = {
      ...emptyInstallMemory,
      staysLocal: { [`${EDITOR}@c.three@1.0.0`]: NOW },
    };
    expect(
      settledState(list, remote, memory, EDITOR, [
        { id: "a.one", kind: "installed" },
        { id: "c.three", kind: "staysLocal" },
      ]),
    ).toEqual({ kind: "inSync", installed: 1, staysLocal: 1 });
  });
});
