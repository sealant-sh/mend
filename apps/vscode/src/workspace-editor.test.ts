import { setTimeout as wait } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { PICKS_KEY, parsePickBook, type PickEntry } from "./editor-picks.js";
import { FileSystemError, Uri, env, fake, workspace } from "./test-vscode.js";
import type { Project, Session } from "./types.js";
import {
  startWorkspaceEditor,
  type WorkspaceEditor,
  type WorkspaceEditorContext,
} from "./workspace-editor.js";

vi.mock("vscode", () => import("./test-vscode.js"));

const SETTING = "mend.workspaces.bringMyEditor";
const AUTHORITY = "ssh-remote+mabc@mend-ws-newsroom-api-0123456789abcdef01234567";
const EXTENSIONS_JSON = "/home/mabc/.vscode-server/extensions/extensions.json";
const EDITORCONFIG = "editorconfig.editorconfig";

const project: Project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session: Session = {
  id: "session-1",
  projectId: project.id,
  harness: "claude",
  model: null,
  label: "session-1",
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: "61aaf28f-f715-4ce1-89be-8626d33acbb6",
  summary: null,
  createdAt: "2026-10-26T09:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: "dana",
};

const encode = (text: string) => new TextEncoder().encode(text);

const personWorkspace = () => {
  let listed: ReadonlyArray<string> = [];
  let held: { readonly started: () => void; readonly gate: Promise<void> } | null = null;
  workspace.fs.readFile = async (uri: Uri) => {
    if (uri.authority !== AUTHORITY) throw FileSystemError.FileNotFound();
    if (uri.path === "/proc/self/status") return encode("Uid:\t40001\t40001\t40001\t40001\n");
    if (uri.path === "/proc/self/environ") return encode("HOME=/home/mabc\0");
    if (uri.path !== EXTENSIONS_JSON) throw FileSystemError.FileNotFound();
    const hold = held;
    held = null;
    if (hold !== null) {
      hold.started();
      await hold.gate;
    }
    return encode(
      JSON.stringify(listed.map((id) => ({ identifier: { id }, metadata: { source: "gallery" } }))),
    );
  };
  return {
    install: (id: string) => {
      listed = [...listed, id];
    },
    holdNextRead: () => {
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      held = { started: started.resolve, gate: gate.promise };
      return { started: started.promise, release: gate.resolve };
    },
  };
};

const stored = new Map<string, unknown>();
const context: WorkspaceEditorContext = {
  globalState: {
    get: (key) => stored.get(key),
    update: async (key, value) => {
      stored.set(key, value);
    },
    setKeysForSync: () => undefined,
  },
  extension: { extensionKind: vscode.ExtensionKind.UI },
  subscriptions: [],
};

const picksOf = (): ReadonlyMap<string, PickEntry> => {
  const book = parsePickBook(stored.get(PICKS_KEY));
  if (book === "unreadable") throw new Error("the book did not parse");
  const [, picks] = [...book.projects].find(([id]) => id === project.id) ?? [];
  return new Map(picks ?? []);
};

let editor: WorkspaceEditor | null = null;
const start = () => {
  editor = startWorkspaceEditor(context, {
    session: () => ({ project, session }),
    onDidLocate: new vscode.EventEmitter<void>().event,
  });
  return editor;
};

beforeEach(() => {
  env.remoteName = "ssh-remote";
  workspace.workspaceFolders = [
    {
      uri: Uri.from({ scheme: "vscode-remote", authority: AUTHORITY, path: "/w" }),
      name: "w",
      index: 0,
    },
  ];
  fake.focus(false);
});

const { readFile } = workspace.fs;
afterEach(() => {
  editor?.dispose();
  editor = null;
  stored.clear();
  env.remoteName = undefined;
  workspace.workspaceFolders = undefined;
  workspace.fs.readFile = readFile;
  fake.reset();
});

describe("startWorkspaceEditor", () => {
  it("writes a panel install after the baseline as a pick of the window's project", async () => {
    const remote = personWorkspace();
    await start().settled();

    remote.install(EDITORCONFIG);
    fake.extensionsChanged();
    await wait(0);

    expect(picksOf().get(EDITORCONFIG)).toMatchObject({ kind: "picked", preRelease: false });
  });

  it.each([
    ["with an observation queued behind the held read", true],
    ["with no observation queued", false],
  ])("records nothing installed while the setting was off, %s", async (_name, queued) => {
    const remote = personWorkspace();
    const opened = start();
    await opened.settled();

    const read = remote.holdNextRead();
    fake.extensionsChanged();
    await read.started;
    if (queued) fake.extensionsChanged();
    fake.configure(SETTING, "off");
    read.release();
    await wait(0);

    remote.install(EDITORCONFIG);
    fake.configure(SETTING, "picked");
    await opened.settled();

    expect(picksOf().get(EDITORCONFIG)).toBeUndefined();
  });
});
