import { describe, expect, it } from "vitest";

import {
  emptyInstallMemory,
  planReinstall,
  type InstallMemory,
  type Listed,
  type Presence,
  type WorkspaceList,
} from "./editor-extensions.js";
import { extensionId, type ExtensionId, type Wanted } from "./editor-picks.js";
import {
  notInWorkspaceReason,
  settledState,
  statusView,
  type EditorSyncState,
} from "./editor-status.js";

const id = (raw: string): ExtensionId => {
  const parsed = extensionId(raw);
  if (parsed === null) throw new Error(`not an extension id: ${raw}`);
  return parsed;
};
const wanted = (raw: string): Wanted => ({ id: id(raw), preRelease: false });
const listOf = (...raws: ReadonlyArray<string>): WorkspaceList =>
  new Map(
    raws.map((raw): [ExtensionId, Listed] => [
      id(raw),
      { id: id(raw), source: "gallery", preRelease: false },
    ]),
  );
const listing = (...raws: ReadonlyArray<string>): Presence => ({
  list: listOf(...raws),
  inUiHost: new Set(),
});

describe("statusView", () => {
  it.each<[EditorSyncState, string | null, string | null]>([
    [{ kind: "inactive" }, null, null],
    [{ kind: "checking" }, "checking extensions", "mend.showWorkspaceEditorLog"],
    [{ kind: "sharedHome" }, "editor stays local · shared home", "mend.showWorkspaceEditorLog"],
    [
      { kind: "noProject" },
      "extensions not carried · not signed in",
      "mend.showWorkspaceEditorLog",
    ],
    [
      { kind: "installing", current: 1, total: 1 },
      "installing extensions 1/1",
      "mend.showWorkspaceEditorLog",
    ],
    [
      { kind: "inSync", carried: 0, installed: 0 },
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

  it("says what a pass did, what the project carries and why it did not sync", () => {
    expect(statusView({ kind: "inSync", carried: 3, installed: 1 })?.tooltip).toBe(
      "Mend installed 1 extension this project carries.",
    );
    expect(statusView({ kind: "inSync", carried: 1, installed: 0 })?.tooltip).toBe(
      "This workspace has the 1 extension this project carries.",
    );
    expect(statusView({ kind: "inSync", carried: 0, installed: 0 })?.tooltip).toBe(
      "The extensions you install here are carried to later sessions of this project.",
    );
    expect(statusView({ kind: "noProject" })?.tooltip).toContain("Sign in to Mend");
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
  const NOW = 1_792_270_215_287;

  it("is in sync when the workspace lists every id the project carries", () => {
    expect(
      settledState([wanted("a.one"), wanted("b.two")], listing("a.one", "b.two", "c.three"), [
        { id: id("b.two"), kind: "installed" },
      ]),
    ).toEqual({ kind: "inSync", carried: 2, installed: 1 });
    expect(settledState([], listing(), [])).toEqual({ kind: "inSync", carried: 0, installed: 0 });
  });

  it("is in sync when the window runs a pick in its UI host instead", () => {
    expect(
      settledState([wanted("a.one")], { list: listOf(), inUiHost: new Set([id("a.one")]) }, []),
    ).toEqual({ kind: "inSync", carried: 1, installed: 0 });
  });

  it("a gallery miss remembered within the day plans nothing and settles not synced, naming it", () => {
    const memory: InstallMemory = { ...emptyInstallMemory, missing: { "c.three": NOW - 1_000 } };
    const project = [wanted("a.one"), wanted("c.three")];
    expect(planReinstall(project, listing("a.one"), new Set(), memory, NOW)).toEqual({
      install: [],
      recentlyMissing: ["c.three"],
    });
    const state = settledState(project, listing("a.one"), []);
    expect(state).toEqual({
      kind: "notSynced",
      reason: "1 extension is not in this workspace: c.three.",
    });
    expect(statusView(state)?.text).toBe("extensions not synced · Sync");
  });
});
