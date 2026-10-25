import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  INSTALL_MEMORY_KEY,
  LOCAL_EXTENSIONS_KEY,
  TimedOut,
  absentAfterInstall,
  captureLocalExtensions,
  classifyInstallFailure,
  editorIdentity,
  emptyInstallMemory,
  learn,
  parseEditorMode,
  parseInstallMemory,
  parseLocalExtensions,
  parseProvenance,
  parseRemoteExtensions,
  planExtensions,
  pruneUninstalled,
  runInstalls,
  sameCapture,
  type EditorMode,
  type InstallMemory,
  type InstallResult,
  type LocalExtensions,
  type ProvenanceIn,
  type RemoteExtensions,
} from "./editor-extensions.js";
import { MendWorkspace, editorHomeOf, parseRemoteProcess } from "./editor-home.js";
import {
  LOG_COMMAND,
  SYNC_COMMAND,
  settledState,
  statusView,
  type EditorSyncState,
} from "./editor-status.js";

export interface WorkspaceEditorReport {
  readonly state: EditorSyncState;
  readonly mode: EditorMode;
  readonly planned: ReadonlyArray<string>;
  readonly results: ReadonlyArray<InstallResult>;
  readonly syncMs: number;
  readonly machineSettings: "not in this build" | null;
}

interface PassResult {
  readonly state: EditorSyncState;
  readonly planned: ReadonlyArray<string>;
  readonly results: ReadonlyArray<InstallResult>;
}

export interface WorkspaceEditor {
  readonly settled: () => Promise<WorkspaceEditorReport>;
  readonly dispose: () => void;
}

const SETTING = "mend.workspaces.bringMyEditor";
const REMOTE_READ_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 120_000;
const PROPAGATION_WAIT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const within = <T>(ms: number, work: Thenable<T>): Promise<T> =>
  Promise.race([Promise.resolve(work), sleep(ms).then(() => Promise.reject(new TimedOut()))]);

const attempt = async <T>(
  work: () => Promise<T>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly cause: unknown }
> => {
  try {
    return { ok: true, value: await work() };
  } catch (cause) {
    return { ok: false, cause };
  }
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

const currentMode = (): EditorMode =>
  parseEditorMode(vscode.workspace.getConfiguration().get<unknown>(SETTING));

const failureCode = (cause: unknown): string => {
  if (cause instanceof TimedOut) return "timed out";
  return cause instanceof vscode.FileSystemError ? cause.code : "error";
};

const readLocal = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const cachedLocalProvenance = (): ProvenanceIn => {
  const read = new Map<string, ReturnType<typeof parseProvenance>>();
  return (folder) => {
    if (!read.has(folder)) {
      const text = readLocal(path.join(folder, "extensions.json"));
      read.set(folder, text === null ? null : parseProvenance(text));
    }
    return read.get(folder) ?? null;
  };
};

const thisEditor = (): string => {
  const kinds = JSON.stringify(
    vscode.workspace.getConfiguration("remote").get("extensionKind") ?? {},
  );
  const digest = createHash("sha256").update(kinds).digest("hex").slice(0, 12);
  return editorIdentity(vscode.env.appName, vscode.version, digest);
};

const settle = (
  state: EditorSyncState,
  planned: ReadonlyArray<string> = [],
  results: ReadonlyArray<InstallResult> = [],
): PassResult => ({ state, planned, results });

export const startWorkspaceEditor = (context: vscode.ExtensionContext): WorkspaceEditor => {
  const disposables: Array<vscode.Disposable> = [];
  let channel: vscode.OutputChannel | null = null;
  let item: vscode.StatusBarItem | null = null;
  const log = (line: string) => {
    channel ??= vscode.window.createOutputChannel("Mend: workspace editor");
    channel.appendLine(`${new Date().toISOString()} ${line}`);
  };
  const show = (state: EditorSyncState) => {
    const view = statusView(state);
    if (view === null) {
      item?.hide();
      return;
    }
    item ??= vscode.window.createStatusBarItem(
      "mend.workspaceEditor",
      vscode.StatusBarAlignment.Left,
      29,
    );
    item.name = "Mend: workspace editor";
    item.text = view.text;
    item.tooltip = view.tooltip;
    item.command = view.command;
    item.show();
  };

  const runsInUiHost = context.extension.extensionKind !== vscode.ExtensionKind.Workspace;
  const local = vscode.env.remoteName === undefined;

  const capture = () => {
    const captured = captureLocalExtensions(
      vscode.extensions.all.map((extension) => ({
        id: extension.id,
        extensionPath: extension.extensionPath,
        packageJSON: extension.packageJSON,
      })),
      vscode.env.appRoot,
      cachedLocalProvenance(),
    );
    const stored = parseLocalExtensions(context.globalState.get(LOCAL_EXTENSIONS_KEY));
    if (stored !== null && sameCapture(stored, captured)) return;
    const record: LocalExtensions = { version: 1, capturedAt: Date.now(), ...captured };
    void context.globalState.update(LOCAL_EXTENSIONS_KEY, record);
  };

  const readRemote = async (workspace: MendWorkspace, file: string, absentAs?: string) => {
    const uri = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: workspace.authority,
      path: file,
    });
    try {
      const bytes = await within(REMOTE_READ_TIMEOUT_MS, vscode.workspace.fs.readFile(uri));
      return new TextDecoder().decode(bytes);
    } catch (cause) {
      if (
        absentAs !== undefined &&
        cause instanceof vscode.FileSystemError &&
        cause.code === "FileNotFound"
      ) {
        return absentAs;
      }
      throw cause;
    }
  };

  const pass = async (mode: EditorMode, signal: AbortSignal): Promise<PassResult> => {
    const unreadable = (what: string, cause: unknown) => {
      log(`could not read ${what} (${failureCode(cause)})`);
      return settle({ kind: "notSynced", reason: "Mend could not read this workspace." });
    };
    const workspace = MendWorkspace.ofWindow(
      vscode.env.remoteName,
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "vscode-remote")
        .map((folder) => folder.uri.authority),
    );
    if (mode === "off" || !runsInUiHost || workspace === null) return settle({ kind: "inactive" });
    show({ kind: "checking" });
    log(`pass started in ${workspace.alias}`);
    const procFiles = await attempt(() =>
      Promise.all([
        readRemote(workspace, "/proc/self/status"),
        readRemote(workspace, "/proc/self/environ"),
      ]),
    );
    if (!procFiles.ok) return unreadable("who the workspace runs as", procFiles.cause);
    const remoteProcess = parseRemoteProcess(...procFiles.value);
    if (remoteProcess === null) {
      log("the workspace did not say who it runs as");
      return settle({ kind: "notSynced", reason: "Mend could not read this workspace." });
    }
    const home = editorHomeOf(workspace, remoteProcess);
    if (home.kind === "shared") {
      log("shared home: nothing is installed here");
      return settle({ kind: "sharedHome" });
    }
    log("person home");
    const stored = parseLocalExtensions(context.globalState.get(LOCAL_EXTENSIONS_KEY));
    if (stored === null) {
      log("no local list: open a local VS Code window once");
      return settle({ kind: "noLocalList" });
    }
    const localList = pruneUninstalled(stored, cachedLocalProvenance());
    for (const id of localList.fromFile) log(`${id}: installed from a file, not synced`);
    const readRemoteList = async () =>
      parseRemoteExtensions(await readRemote(workspace, home.extensionsJson, ""));
    const remoteRead = await attempt(readRemoteList);
    if (!remoteRead.ok) return unreadable("the workspace's extensions", remoteRead.cause);
    const remote = remoteRead.value;
    const memory =
      parseInstallMemory(context.globalState.get(INSTALL_MEMORY_KEY)) ?? emptyInstallMemory;
    const identity = thisEditor();
    const plan = planExtensions(localList, remote, memory, identity, Date.now());
    log(
      `local list: ${plural(localList.extensions.length, "extension")} (recorded ${new Date(localList.capturedAt).toISOString()}); the workspace lists ${remote.size}; installing ${plan.install.length === 0 ? "none" : plan.install.map((ref) => ref.id).join(", ")}`,
    );
    for (const id of plan.recentlyMissing) {
      log(`${id}: the gallery had no such extension within the last day; not asked for again yet`);
    }
    const planned = plan.install.map((ref) => ref.id);
    const settledAgainst = (
      after: RemoteExtensions,
      memoryAfter: InstallMemory,
      results: ReadonlyArray<InstallResult>,
    ): PassResult =>
      settle(settledState(localList, after, memoryAfter, identity, results), planned, results);
    if (plan.install.length === 0) return settledAgainst(remote, memory, []);

    const run = await runInstalls(plan.install, {
      install: async (id) => {
        const started = Date.now();
        try {
          // Without donotSync, VS Code with Settings Sync on asks before each install into the
          // workspace. An id this window already runs locally is only rewritten in place, where
          // donotSync would mark the local copy machine-scoped and drop it from Settings Sync.
          const runsLocally = vscode.extensions.getExtension(id) !== undefined;
          await within(
            INSTALL_TIMEOUT_MS,
            vscode.commands.executeCommand(
              "workbench.extensions.installExtension",
              id,
              runsLocally ? undefined : { donotSync: true },
            ),
          );
          log(`${id}: reported installed (${Date.now() - started} ms)`);
        } catch (cause) {
          log(`${id}: ${classifyInstallFailure(cause)} (${Date.now() - started} ms)`);
          throw cause;
        }
      },
      sleep,
      signal,
      onProgress: (current, total) => show({ kind: "installing", current, total }),
    });
    if (run.kind === "stopped") {
      log("stopped before the plan finished; the next pass picks up what is still missing");
      return settle({ kind: "inactive" }, planned);
    }

    let after = remote;
    try {
      after = await readRemoteList();
      for (
        const deadline = Date.now() + PROPAGATION_WAIT_MS;
        absentAfterInstall(run.outcomes, after).length > 0 && Date.now() < deadline;
      ) {
        await sleep(500);
        after = await readRemoteList();
      }
    } catch (cause) {
      log(`could not re-read the workspace's extensions (${failureCode(cause)})`);
    }
    const lesson = learn(
      memory,
      run,
      after,
      (id) => vscode.extensions.getExtension(id) !== undefined,
      identity,
      Date.now(),
    );
    await context.globalState.update(INSTALL_MEMORY_KEY, lesson.memory);
    for (const result of lesson.results) {
      if (result.kind === "staysLocal")
        log(`${result.id}: runs in the local window only; not asked for again at this version`);
      if (result.kind === "unresolved")
        log(
          `${result.id}: reported installed but the workspace does not list it; tried again next open`,
        );
      if (result.kind === "missing")
        log(`${result.id}: the gallery has no such extension; asked for again tomorrow`);
      if (result.kind === "failed") log(`${result.id}: not installed (${result.failure})`);
    }
    return settledAgainst(after, lesson.memory, lesson.results);
  };

  let controller = new AbortController();
  let running: Promise<WorkspaceEditorReport> | null = null;
  let latest: Promise<WorkspaceEditorReport>;
  const start = (): Promise<WorkspaceEditorReport> => {
    if (running !== null) return running;
    controller = new AbortController();
    const mode = currentMode();
    const started = Date.now();
    const current = pass(mode, controller.signal)
      .catch((cause: unknown): PassResult => {
        log(`pass failed (${cause instanceof Error ? cause.name : "error"})`);
        return {
          state: { kind: "notSynced", reason: "Mend could not finish." },
          planned: [],
          results: [],
        };
      })
      .then((result): WorkspaceEditorReport => {
        const report: WorkspaceEditorReport = {
          ...result,
          mode,
          syncMs: Date.now() - started,
          machineSettings: mode === "extensionsAndSettings" ? "not in this build" : null,
        };
        show(report.state);
        if (report.state.kind !== "inactive") {
          log(
            `settled: ${statusView(report.state)?.text ?? report.state.kind} (${report.syncMs} ms)${report.machineSettings === null ? "" : "; machine settings: not in this build"}`,
          );
        }
        running = null;
        return report;
      });
    running = current;
    latest = current;
    return current;
  };

  disposables.push(
    vscode.commands.registerCommand(SYNC_COMMAND, async () => {
      const report = await start();
      if (report.state.kind === "inactive") {
        void vscode.window.showInformationMessage(
          "Mend brings your editor into Mend workspace windows, while mend.workspaces.bringMyEditor is on.",
        );
      }
      return report;
    }),
    vscode.commands.registerCommand(LOG_COMMAND, () => {
      channel ??= vscode.window.createOutputChannel("Mend: workspace editor");
      channel.show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SETTING)) return;
      if (currentMode() === "off") {
        controller.abort();
        show({ kind: "inactive" });
        return;
      }
      if (local && runsInUiHost) capture();
      else void start();
    }),
  );
  if (local && runsInUiHost) {
    disposables.push(
      vscode.extensions.onDidChange(() => {
        if (currentMode() !== "off") capture();
      }),
    );
    if (currentMode() !== "off") capture();
  }
  void start();

  const editorHandle: WorkspaceEditor = {
    settled: () => latest,
    dispose: () => {
      controller.abort();
      for (const disposable of disposables) disposable.dispose();
      item?.dispose();
      channel?.dispose();
    },
  };
  context.subscriptions.push(editorHandle);
  return editorHandle;
};
