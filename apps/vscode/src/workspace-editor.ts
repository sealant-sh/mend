import * as path from "node:path";

import * as vscode from "vscode";

import {
  INSTALL_MEMORY_KEY,
  TimedOut,
  absentAfterInstall,
  classifyInstallFailure,
  noteOutcomes,
  parseEditorMode,
  parseInstallMemory,
  parseWorkspaceList,
  planReinstall,
  runInstalls,
  type EditorMode,
  type InstallResult,
} from "./editor-extensions.js";
import { MendWorkspace, editorHomeOf, parseRemoteProcess, type PersonHome } from "./editor-home.js";
import {
  PROPAGATION_WAIT_MS,
  inFlight,
  initialObserver,
  observe as observeEvent,
  type ObserverEvent,
  type ReadResult,
  type RestoreOutcome,
} from "./editor-observer.js";
import {
  PICKS_KEY,
  holds,
  parsePickBook,
  projectId,
  storedBook,
  wantedBy,
  withEntries,
  type ProjectId,
  type ProjectPicks,
} from "./editor-picks.js";
import {
  LOG_COMMAND,
  SYNC_COMMAND,
  settledState,
  statusView,
  type EditorSyncState,
} from "./editor-status.js";
import type { WorkspaceWindow } from "./workspace-window.js";

export interface WorkspaceEditorReport {
  readonly state: EditorSyncState;
  readonly mode: EditorMode;
  readonly planned: ReadonlyArray<string>;
  readonly results: ReadonlyArray<InstallResult>;
  readonly syncMs: number;
  /** The project's picks after this pass: what its next session installs. */
  readonly carried: ReadonlyArray<string>;
}

interface PassResult {
  readonly state: EditorSyncState;
  readonly planned: ReadonlyArray<string>;
  readonly results: ReadonlyArray<InstallResult>;
  readonly carried: ReadonlyArray<string>;
}

export interface WorkspaceEditor {
  readonly settled: () => Promise<WorkspaceEditorReport>;
  readonly dispose: () => void;
}

const SETTING = "mend.workspaces.bringMyEditor";
/** The first design's capture of every local extension; cleared, never read. */
const LOCAL_EXTENSIONS_KEY = "mend.editor.localExtensions";
const REMOTE_READ_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 120_000;
const LOCATE_WAIT_MS = 30_000;
const FOCUSED_READ_MS = 10_000;
/** Another window's whole-memento write can drop this one's; the recheck writes it again. */
const RECHECK_MS = 2_000;

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

const settle = (
  state: EditorSyncState,
  planned: ReadonlyArray<string> = [],
  results: ReadonlyArray<InstallResult> = [],
  carried: ReadonlyArray<string> = [],
): PassResult => ({ state, planned, results, carried });

/** One read and one waiting read at most: later callers share the waiting one. */
const serialized = <T>(work: () => Promise<T>): (() => Promise<T>) => {
  let running: Promise<T> | null = null;
  let waiting: Promise<T> | null = null;
  const run = (): Promise<T> => {
    if (running === null) {
      running = work().finally(() => {
        running = null;
      });
      return running;
    }
    waiting ??= running
      .catch(() => undefined)
      .then(() => {
        waiting = null;
        return run();
      });
    return waiting;
  };
  return run;
};

export const startWorkspaceEditor = (
  context: vscode.ExtensionContext,
  window: Pick<WorkspaceWindow, "session" | "onDidLocate">,
): WorkspaceEditor => {
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

  context.globalState.setKeysForSync([PICKS_KEY]);
  if (context.globalState.get(LOCAL_EXTENSIONS_KEY) !== undefined) {
    void context.globalState.update(LOCAL_EXTENSIONS_KEY, undefined);
  }

  const runsInUiHost = context.extension.extensionKind !== vscode.ExtensionKind.Workspace;

  const readRemote = async (workspace: MendWorkspace, file: string) => {
    const uri = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: workspace.authority,
      path: file,
    });
    const bytes = await within(REMOTE_READ_TIMEOUT_MS, vscode.workspace.fs.readFile(uri));
    return new TextDecoder().decode(bytes);
  };

  let observer = initialObserver;
  let target: { readonly workspace: MendWorkspace; readonly home: PersonHome } | null = null;
  let watcher: vscode.FileSystemWatcher | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  let passProject: ProjectId | null = null;
  let lastReadFailure: string | null = null;
  let unreadableLogged = false;

  const located = (): ProjectId | null => {
    const shown = window.session();
    return shown === null ? null : projectId(shown.project.id);
  };

  const readBook = () => {
    const book = parsePickBook(context.globalState.get(PICKS_KEY));
    if (book === "unreadable" && !unreadableLogged) {
      unreadableLogged = true;
      log(
        "the extensions each project carries were written by a newer Mend; Mend leaves them as they are",
      );
    }
    return book;
  };

  const carried = (project: ProjectId): ReadonlyArray<string> => {
    const book = readBook();
    return book === "unreadable" ? [] : wantedBy(book, project).map((ref) => ref.id);
  };

  const bookOf = (project: ProjectId | null): ProjectPicks => {
    if (project === null) return new Map();
    const book = readBook();
    return book === "unreadable" ? new Map() : (book.projects.get(project) ?? new Map());
  };

  const dispatch = (event: ObserverEvent) => {
    const { observer: next, entries, fromFile } = observeEvent(observer, event);
    observer = next;
    for (const [id, entry] of entries) {
      log(
        entry.kind === "picked"
          ? `${id}: carried to later sessions of this project${entry.preRelease ? " (pre-release)" : ""}`
          : `${id}: no longer carried`,
      );
    }
    for (const id of fromFile) log(`${id}: installed from a file, not carried`);
  };

  const flush = async (): Promise<void> => {
    const project = located();
    const { journal } = observer;
    if (project === null || journal.size === 0) return;
    const book = readBook();
    if (book === "unreadable" || holds(book, project, journal)) return;
    try {
      await context.globalState.update(PICKS_KEY, storedBook(withEntries(book, project, journal)));
    } catch (cause) {
      log(
        `could not save the extensions this project carries (${failureCode(cause)}); tries again on the next read`,
      );
      return;
    }
    recheck ??= setTimeout(() => {
      recheck = null;
      void flush();
    }, RECHECK_MS);
  };

  const readList = async (workspace: MendWorkspace, home: PersonHome): Promise<ReadResult> => {
    let text: string;
    try {
      text = await readRemote(workspace, home.extensionsJson);
    } catch (cause) {
      if (cause instanceof vscode.FileSystemError && cause.code === "FileNotFound") {
        return { kind: "fileNotFound" };
      }
      const code = failureCode(cause);
      if (lastReadFailure !== code) log(`could not read the workspace's extensions (${code})`);
      lastReadFailure = code;
      return { kind: "unreadable" };
    }
    lastReadFailure = null;
    watch(workspace, home);
    const list = parseWorkspaceList(text);
    if (list === null) log("the workspace's extensions.json did not parse; read again later");
    return list === null ? { kind: "unreadable" } : { kind: "list", list };
  };

  const observe = serialized(async (): Promise<void> => {
    if (target === null) return;
    const { generation } = observer;
    const result = await readList(target.workspace, target.home);
    dispatch({
      kind: "read",
      generation,
      at: Date.now(),
      result,
      book: bookOf(located()),
    });
    // Settings Sync or another window can replace the book at any time, so every observation
    // checks that the book still holds what this window saw.
    await flush();
  });

  const observeWhileOn = () => {
    if (currentMode() !== "off") void observe();
  };

  const tick = (focused: boolean) => {
    if (focused && ticker === null) ticker = setInterval(observeWhileOn, FOCUSED_READ_MS);
    if (!focused && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  /** VS Code sends no extension event for the uninstall of an extension that already activated. */
  const watch = (workspace: MendWorkspace, home: PersonHome) => {
    if (watcher !== null) return;
    const folder = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: workspace.authority,
      path: path.posix.dirname(home.extensionsJson),
    });
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, path.posix.basename(home.extensionsJson)),
    );
    watcher.onDidChange(observeWhileOn);
    watcher.onDidCreate(observeWhileOn);
    watcher.onDidDelete(observeWhileOn);
  };

  const arm = (workspace: MendWorkspace, home: PersonHome) => {
    if (target !== null) return;
    target = { workspace, home };
    disposables.push(
      vscode.extensions.onDidChange(observeWhileOn),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) observeWhileOn();
        tick(state.focused);
      }),
    );
    tick(vscode.window.state.focused);
  };

  const locate = async (signal: AbortSignal): Promise<ProjectId | null> => {
    const now = located();
    if (now !== null || signal.aborted) return now;
    const cleanup: Array<() => void> = [];
    try {
      return await new Promise<ProjectId | null>((resolve) => {
        const listener = window.onDidLocate(() => {
          const project = located();
          if (project !== null) resolve(project);
        });
        const timer = setTimeout(() => resolve(null), LOCATE_WAIT_MS);
        const stop = () => resolve(null);
        signal.addEventListener("abort", stop, { once: true });
        cleanup.push(
          () => listener.dispose(),
          () => clearTimeout(timer),
          () => signal.removeEventListener("abort", stop),
        );
      });
    } finally {
      for (const step of cleanup) step();
    }
  };

  const pass = async (mode: EditorMode, signal: AbortSignal): Promise<PassResult> => {
    const stopped = settle({ kind: "inactive" });
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
    if (signal.aborted) return stopped;
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
    arm(workspace, home);
    const { generation } = observer;
    await observe();
    if (signal.aborted) return stopped;
    if (observer.previous === null) {
      return settle({ kind: "notSynced", reason: "Mend could not read this workspace." });
    }
    const project = await locate(signal);
    if (signal.aborted) return stopped;
    passProject = project;
    if (project === null) {
      log("no session of this window that this person can see: extensions are not carried yet");
      return settle({ kind: "noProject" });
    }
    // Locating can wait 30 s while the person installs: plan against what the workspace lists now.
    await observe();
    const list = observer.previous;
    if (signal.aborted || list === null) return stopped;
    const book = readBook();
    if (book === "unreadable") {
      return settle({
        kind: "notSynced",
        reason: "Mend could not read the extensions this project carries.",
      });
    }
    const wanted = wantedBy(book, project);
    const memory = parseInstallMemory(context.globalState.get(INSTALL_MEMORY_KEY));
    const inUiHost = new Set(
      wanted.flatMap((ref) =>
        vscode.extensions.getExtension(ref.id) === undefined ? [] : [ref.id],
      ),
    );
    for (const id of inUiHost) {
      if (!list.has(id)) log(`${id}: this window runs it locally; not installed in the workspace`);
    }
    const plan = planReinstall(wanted, { list, inUiHost }, inFlight(observer), memory, Date.now());
    const planned = plan.install.map((ref) => ref.id);
    log(
      `this project carries ${plural(wanted.length, "extension")}; the workspace lists ${list.size}; installing ${planned.length === 0 ? "none" : planned.join(", ")}`,
    );
    for (const id of plan.recentlyMissing) {
      log(`${id}: the gallery had no such extension within the last day; not asked for again yet`);
    }
    if (plan.install.length === 0) {
      return settle(settledState(wanted, { list, inUiHost }, []), planned, [], carried(project));
    }

    const run = await runInstalls(plan.install, {
      install: async (ref) => {
        const started = Date.now();
        // Without donotSync, VS Code with Settings Sync on asks before each install into the workspace.
        const command = Promise.resolve(
          vscode.commands.executeCommand("workbench.extensions.installExtension", ref.id, {
            donotSync: true,
            ...(ref.preRelease ? { installPreReleaseVersion: true } : {}),
          }),
        );
        dispatch({ kind: "restoreStarted", generation, id: ref.id });
        // The deadline below ends only Mend's wait. VS Code's install runs on, and the id stays
        // Mend's until it settles.
        const settled = (outcome: RestoreOutcome) => () =>
          dispatch({ kind: "restoreSettled", generation, id: ref.id, outcome, at: Date.now() });
        void command.then(settled("reported"), settled("failed"));
        try {
          await within(INSTALL_TIMEOUT_MS, command);
          log(`${ref.id}: reported installed (${Date.now() - started} ms)`);
        } catch (cause) {
          log(`${ref.id}: ${classifyInstallFailure(cause)} (${Date.now() - started} ms)`);
          throw cause;
        }
      },
      sleep,
      signal,
      onProgress: (current, total) => {
        if (!signal.aborted) show({ kind: "installing", current, total });
      },
    });
    if (run.kind === "stopped" || signal.aborted) {
      log("stopped before the plan finished; the next pass picks up what is still missing");
      return settle({ kind: "inactive" }, planned);
    }

    await observe();
    const listed = () => observer.previous ?? list;
    for (
      const deadline = Date.now() + PROPAGATION_WAIT_MS;
      absentAfterInstall(run.outcomes, listed()).length > 0 && Date.now() < deadline;
    ) {
      await sleep(500);
      await observe();
    }
    if (signal.aborted) return stopped;
    const after = listed();
    const noted = noteOutcomes(memory, run, after, Date.now());
    await context.globalState.update(INSTALL_MEMORY_KEY, noted.memory);
    for (const result of noted.results) {
      if (result.kind === "notListed")
        log(
          `${result.id}: reported installed but the workspace does not list it; tried again next open`,
        );
      if (result.kind === "missing")
        log(`${result.id}: the gallery has no such extension; asked for again tomorrow`);
      if (result.kind === "failed") log(`${result.id}: not installed (${result.failure})`);
    }
    return settle(
      settledState(wanted, { list: after, inUiHost }, noted.results),
      planned,
      noted.results,
      carried(project),
    );
  };

  let controller = new AbortController();
  let running: Promise<WorkspaceEditorReport> | null = null;
  let latest: Promise<WorkspaceEditorReport>;
  const start = (): Promise<WorkspaceEditorReport> => {
    if (running !== null) return running;
    controller = new AbortController();
    const { signal } = controller;
    const mode = currentMode();
    const started = Date.now();
    const current = pass(mode, signal)
      .catch((cause: unknown): PassResult => {
        log(`pass failed (${cause instanceof Error ? cause.name : "error"})`);
        return settle({ kind: "notSynced", reason: "Mend could not finish." });
      })
      .then((result): WorkspaceEditorReport => {
        const report: WorkspaceEditorReport = { ...result, mode, syncMs: Date.now() - started };
        if (running === current) running = null;
        if (signal.aborted) return report;
        show(report.state);
        if (report.state.kind !== "inactive") {
          log(
            `settled: ${statusView(report.state)?.text ?? report.state.kind} (${report.syncMs} ms)`,
          );
        }
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
          "Mend carries the extensions you install in a project's Mend workspace window to its later sessions, while mend.workspaces.bringMyEditor is picked.",
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
        running = null;
        dispatch({ kind: "off" });
        show({ kind: "inactive" });
        return;
      }
      void start();
    }),
    // The window locates its session again on every Open; only a new project needs a new pass.
    window.onDidLocate(() => {
      if (currentMode() !== "off" && located() !== passProject) void start();
    }),
  );
  void start();

  const editorHandle: WorkspaceEditor = {
    settled: () => latest,
    dispose: () => {
      controller.abort();
      for (const disposable of disposables) disposable.dispose();
      watcher?.dispose();
      if (ticker !== null) clearInterval(ticker);
      if (recheck !== null) clearTimeout(recheck);
      item?.dispose();
      channel?.dispose();
    },
  };
  context.subscriptions.push(editorHandle);
  return editorHandle;
};
