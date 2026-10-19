import * as path from "node:path";

import { repositoryCloneUrlIssue } from "@mend/domain/workbench";
import * as vscode from "vscode";

import { attachTerminal, memberName } from "./agent-terminal.js";
import { MendApiError, MendClient, normalizeProjectName } from "./client.js";
import { ConnectionStore } from "./config.js";
import { currentBranch, worktreePath } from "./git.js";
import { Launches } from "./launches.js";
import { OFFER_COMMANDS, openRunner, setUpWorkspaceSsh } from "./open-command.js";
import type { OpenMode } from "./open-flow.js";
import { OpenIntents } from "./open-intent.js";
import type { OpenRunner } from "./open-runner.js";
import {
  maySteer,
  ownsSession,
  pickDescription,
  rowCapability,
  rowOffer,
  stopRefusal,
  type RowCapability,
  type RowOffer,
} from "./session-capability.js";
import { displaySession } from "./session-lines.js";
import { ownLine, type SessionView } from "./session-model.js";
import { SessionStore } from "./session-store.js";
import { MendStatusBar, Notifier } from "./session-surfaces.js";
import { ToastClaims } from "./toast-claims.js";
import {
  MendTreeProvider,
  isProjectNode,
  isSessionNode,
  sessionIdOf,
  type ProjectNode,
  type SessionNode,
} from "./tree.js";
import { attachableProcesses, type TtyAddress } from "./tty-protocol.js";
import type { Project, ProjectDetail, Session, SessionLocation, WorktreeJoin } from "./types.js";
import { terminalTabName, windowRole } from "./window-role.js";
import { startWorkspaceEditor, type WorkspaceEditorReport } from "./workspace-editor.js";
import { WorkspaceWindow } from "./workspace-window.js";

const liveStatuses: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/** New session title: the project, plus the worktree when the session joins one. */
const newSessionTitle = (project: Project, join: WorktreeJoin | null): string =>
  join === null ? `New session · ${project.name}` : `New session · ${project.name} › ${join.name}`;

const errorMessage = (cause: unknown): string =>
  cause instanceof MendApiError && cause.status === 401
    ? `${cause.message} Run Mend: Connect to server to sign in.`
    : cause instanceof MendApiError || cause instanceof Error
      ? cause.message
      : "Mend could not complete that action.";

/** The error, with Connect offered when the server refused the token. */
const showError = async (cause: unknown): Promise<void> => {
  const action =
    cause instanceof MendApiError && cause.status === 401
      ? await vscode.window.showErrorMessage(errorMessage(cause), "Connect to server")
      : await vscode.window.showErrorMessage(errorMessage(cause));
  if (action === "Connect to server") await vscode.commands.executeCommand("mend.connect");
};

interface ProjectPick extends vscode.QuickPickItem {
  readonly project: Project;
}

interface SessionPick extends vscode.QuickPickItem {
  readonly action: "session";
  readonly session: Session;
}

/** A session in a picker that opens: picking it does `offer`, which the item says. */
interface OfferPick extends SessionPick {
  readonly offer: RowOffer;
}

/**
 * What the viewer may do with each of these sessions, by the row's rule. The roster is read only
 * when one of them is someone else's, to name its launcher.
 */
const capabilitiesOf = async (
  client: MendClient,
  store: SessionStore,
  sessions: ReadonlyArray<Session>,
): Promise<(session: Session) => RowCapability> => {
  const viewer = store.viewer() ?? (await client.viewerId());
  const named = sessions.some(
    (session) => rowCapability({ session, viewer, members: [] }).kind === "notYours",
  );
  const members = named ? await client.memberNames() : [];
  return (session) => rowCapability({ session, viewer, members });
};

/** How a session's row reads, from the store's last read; from the session alone before one. */
const lineOf = (store: SessionStore, session: Session): string =>
  store.model()?.sessions.get(session.id)?.line ?? ownLine(session);

const offerPick = (
  session: Session,
  capability: RowCapability,
  item: { readonly label: string; readonly line: string; readonly detail?: string },
): OfferPick => {
  const detail = capability.kind === "notYours" ? capability.why : item.detail;
  return {
    label: item.label,
    description: pickDescription(item.line, capability),
    ...(detail === undefined ? {} : { detail }),
    action: "session",
    session,
    offer: rowOffer(capability),
  };
};

interface ActionPick extends vscode.QuickPickItem {
  readonly action: "new-session" | "open-mend";
}

interface TerminalPick extends vscode.QuickPickItem {
  readonly address: TtyAddress | "new-shell";
}

const NEW_SHELL: TerminalPick = {
  label: "$(add) New shell",
  detail: "A shell in the session's workspace.",
  address: "new-shell",
};

type ScopePick = OfferPick | ActionPick;

/** The session picker's order, the view's: needs you, since you last looked, running, the rest. */
const pickOrder = (view: SessionView): number =>
  view.needsYou ? 0 : view.sinceYouLastLooked ? 1 : view.live ? 2 : 3;

class MendCommands {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionStore,
    private readonly client: MendClient,
    private readonly store: SessionStore,
    private readonly workspaceWindow: WorkspaceWindow,
    private readonly runner: OpenRunner,
  ) {}

  async connect(): Promise<boolean> {
    if (!(await this.connections.configure())) return false;
    this.store.refresh();
    try {
      const connection = await this.client.connection();
      await this.client.listProjects();
      void vscode.window.showInformationMessage(`Connected to Mend at ${connection.url}.`);
    } catch (cause) {
      void showError(cause);
    }
    return true;
  }

  async adoptProject(): Promise<void> {
    try {
      const typed = await vscode.window.showInputBox({
        title: "Adopt a project",
        prompt: "Git clone URL",
        placeHolder: "https://github.com/owner/repository.git",
        ignoreFocusOut: true,
        validateInput: (value) => repositoryCloneUrlIssue(value.trim()),
      });
      if (typed === undefined || typed.trim() === "") return;
      const source = typed.trim();
      const issue = repositoryCloneUrlIssue(source);
      if (issue !== null) {
        void vscode.window.showErrorMessage(issue);
        return;
      }
      const inferred = normalizeProjectName(path.basename(source.replace(/\.git$/, "")));
      const name = await vscode.window.showInputBox({
        title: "Adopt a project",
        prompt: "Project name",
        value: inferred,
        ignoreFocusOut: true,
      });
      if (name === undefined || name.trim() === "") return;
      const project = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Adopting ${name.trim()}…` },
        () => this.client.adoptProject(name.trim(), source),
      );
      this.store.refresh();
      void vscode.window.showInformationMessage(`Adopted ${project.name}.`);
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * Open the session's workspace in VS Code over Remote-SSH: from the row's button, the palette,
   * the quick pick or a deep link. It never asks; a missing setup step is part of its progress.
   */
  async open(argument: unknown, mode: OpenMode): Promise<void> {
    try {
      const location = await this.sessionLocation(argument, (project, sessions) =>
        this.pickToOpen(project, sessions, mode),
      );
      if (location === null) return;
      await this.runner.open({ project: location.project, session: location.session }, mode);
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * The palette's session pick for Open: each session says what picking it does. A session the
   * viewer cannot open runs what it offered instead, and nothing is left to open.
   */
  private async pickToOpen(
    project: Project,
    sessions: ReadonlyArray<Session>,
    mode: OpenMode,
  ): Promise<Session | null> {
    const capability = await capabilitiesOf(this.client, this.store, sessions);
    const picked = await vscode.window.showQuickPick<OfferPick>(
      sessions.map((session) =>
        offerPick(session, capability(session), {
          label: displaySession(session),
          line: lineOf(this.store, session),
        }),
      ),
      { title: `Choose a session · ${project.name}`, ignoreFocusOut: true },
    );
    if (picked === undefined) return null;
    if (picked.offer === "Open") return picked.session;
    await this.act({ kind: "session", project, session: picked.session }, picked.offer, mode);
    return null;
  }

  /** What a picked session offered: Open, or what helps instead of it. */
  private async act(node: SessionNode, offer: RowOffer, mode: OpenMode): Promise<void> {
    if (offer === "Open") await this.open(node, mode);
    else await vscode.commands.executeCommand(OFFER_COMMANDS[offer], node);
  }

  /**
   * Answer a session that waits (rule 8): its agent's tab in this window's panel, attached or
   * shown again, and no window opens. A conversation gets its tab, where Continue here moves it
   * into a terminal, until the Answer flow answers its request in place.
   */
  async answer(argument?: unknown): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      await this.workspaceWindow.answer(location.session.id);
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * Every session that needs her, settled since she last looked, or runs, in the view's order:
   * what the workspace window's others line and its status bar open. Picking one does what its
   * row offers.
   */
  async pickSession(): Promise<void> {
    const model = this.store.model();
    if (model === null) return;
    const own = model.kind === "workspace" ? model.session?.session.id : undefined;
    const picks = [...model.sessions.values()]
      .filter((view) => view.session.id !== own && pickOrder(view) < 3)
      .toSorted((left, right) => pickOrder(left) - pickOrder(right))
      .map(
        (view): OfferPick =>
          offerPick(view.session, view.capability, {
            label: view.name,
            line: view.line,
            detail: view.project.name,
          }),
      );
    const picked = await vscode.window.showQuickPick<OfferPick>(picks, {
      title: "Mend sessions",
      placeHolder: picks.length === 0 ? "Nothing else needs you or runs" : "Choose a session",
      ignoreFocusOut: true,
    });
    if (picked === undefined) return;
    const view = model.sessions.get(picked.session.id);
    if (view === undefined) return;
    await this.act(
      { kind: "session", project: view.project, session: view.session },
      picked.offer,
      "follow-setting",
    );
  }

  /**
   * The session's terminal in a VS Code terminal tab, over Mend's terminal data plane: its agent's
   * PTY or one of its shells, or a new shell. No SSH is involved, so it works wherever the API does.
   * Only the session's owner types; anyone else watches.
   */
  async openTerminal(argument?: unknown): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      const detail = await this.client.sessionDetail(location.session.id);
      const live = attachableProcesses(detail.processes);
      const viewer = this.store.viewer() ?? (await this.client.viewerId());
      // The server lets into a session's terminal whoever may steer it: its owner, and others only
      // while shared control is on, and then they watch (`canSteerSession`, apps/api tty route).
      if (viewer !== null && !maySteer(detail.session, viewer)) {
        void vscode.window.showInformationMessage(
          `${displaySession(detail.session)} is ${await memberName(this.client, detail.session.ownerUserId)}'s session. Its terminal opens for others only while its owner has shared control on.`,
        );
        return;
      }
      const owns = ownsSession(detail.session, viewer);
      const picks: TerminalPick[] = [
        ...live.map((process) => ({
          // A Workbench's shell is its agent process with the `shell` harness.
          label:
            process.kind === "shell" || process.harness === "shell"
              ? `$(terminal) Shell · ${process.id.slice(0, 8)}`
              : `$(sparkle) ${process.harness ?? detail.session.harness}`,
          description: process.status,
          address: { process: process.id },
        })),
        ...(liveStatuses.has(detail.session.status) && owns ? [NEW_SHELL] : []),
      ];
      if (picks.length === 0) {
        void vscode.window.showInformationMessage(
          `${displaySession(detail.session)} has no live terminal. Resume it to open one.`,
        );
        return;
      }
      const picked =
        picks.length === 1 && picks[0]?.address !== "new-shell"
          ? picks[0]
          : await vscode.window.showQuickPick<TerminalPick>(picks, {
              title: `Terminal · ${displaySession(detail.session)}`,
              ignoreFocusOut: true,
            });
      if (picked === undefined) return;
      const address: TtyAddress =
        picked.address === "new-shell"
          ? { process: (await this.client.openShell(detail.session.id)).id }
          : picked.address;
      await attachTerminal(this.client, {
        session: detail.session,
        address,
        name: terminalTabName(
          detail.session,
          live.find((process) => "process" in address && process.id === address.process) ?? null,
        ),
        viewer,
      });
    } catch (cause) {
      void showError(cause);
    }
  }

  /** The session's change in Mend's review, in the browser. */
  async reviewChange(argument?: unknown): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      const detail = await this.client.sessionDetail(location.session.id);
      const connection = await this.client.connection();
      if (detail.changeId === null) {
        void vscode.window.showInformationMessage(
          `${displaySession(detail.session)} has no change to review yet.`,
        );
        return;
      }
      await vscode.env.openExternal(
        vscode.Uri.parse(`${connection.url}/changes/${encodeURIComponent(detail.changeId)}`),
      );
    } catch (cause) {
      void showError(cause);
    }
  }

  async signOut(): Promise<void> {
    const said = await this.connections.signOut();
    this.store.refresh();
    void vscode.window.showInformationMessage(said);
  }

  async openInMend(argument?: unknown): Promise<void> {
    try {
      const connection = await this.client.connection();
      if (isSessionNode(argument)) {
        await vscode.env.openExternal(
          vscode.Uri.parse(`${connection.url}/sessions/${argument.session.id}`),
        );
        return;
      }
      if (isProjectNode(argument)) {
        await vscode.env.openExternal(
          vscode.Uri.parse(`${connection.url}/projects/${argument.project.id}`),
        );
        return;
      }
      const here = this.workspaceWindow.session();
      const project = this.store.windowProject()?.project ?? null;
      const route =
        here === null
          ? project === null
            ? ""
            : `/projects/${project.id}`
          : `/sessions/${here.session.id}`;
      await vscode.env.openExternal(vscode.Uri.parse(`${connection.url}${route}`));
    } catch (cause) {
      void showError(cause);
    }
  }

  async copyWorktreePath(argument?: unknown): Promise<void> {
    const location = await this.sessionLocation(argument);
    if (location === null) return;
    await vscode.env.clipboard.writeText(location.worktreePath);
    void vscode.window.setStatusBarMessage("Mend worktree path copied", 2_000);
  }

  async stopSession(argument?: unknown): Promise<void> {
    const location = await this.sessionLocation(argument);
    if (location === null || !liveStatuses.has(location.session.status)) return;
    try {
      // The row's snapshot may be stale; the server decides from who steers it now.
      const [detail, viewer] = await Promise.all([
        this.client.sessionDetail(location.session.id),
        this.client.viewerId(),
      ]);
      const refusal = await stopRefusal(detail.session, viewer, (userId) =>
        memberName(this.client, userId),
      );
      if (refusal !== null) {
        void vscode.window.showInformationMessage(refusal);
        return;
      }
    } catch (cause) {
      void showError(cause);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Stop ${displaySession(location.session)}?`,
      { modal: true, detail: "The worktree and reviewable change remain." },
      "Stop session",
    );
    if (answer !== "Stop session") return;
    try {
      await this.client.stopSession(location.session.id);
      this.store.refresh();
    } catch (cause) {
      void showError(cause);
    }
  }

  async newSession(argument?: unknown, join: WorktreeJoin | null = null): Promise<void> {
    const project = await this.pickProject(argument);
    if (project === null) return;
    await this.startAgent(project, "claude", join);
  }

  /**
   * Another session inside an existing worktree — the same files, a new conversation. The
   * worktree keeps its base; this session's harness state is its own (each session owns its
   * harness home), so it does not continue a sibling's conversation.
   */
  async newSessionInWorktree(argument?: unknown): Promise<void> {
    const location = await this.sessionLocation(argument);
    if (location === null) return;
    try {
      const name = await this.worktreeNameOf(location);
      if (name === null) {
        void vscode.window.showErrorMessage(
          "This server does not report worktrees, so the session's worktree cannot be joined.",
        );
        return;
      }
      await this.newSession({ kind: "project", project: location.project } satisfies ProjectNode, {
        name,
      });
    } catch (cause) {
      void showError(cause);
    }
  }

  /** The joinable name of the session's worktree; null on a pre-worktree server. */
  private async worktreeNameOf(location: SessionLocation): Promise<string | null> {
    const worktreeId = location.session.worktreeId;
    if (worktreeId === undefined) return null;
    const detail = await this.client.projectDetail(location.project.id);
    return detail.worktrees?.find((worktree) => worktree.id === worktreeId)?.name ?? null;
  }

  /** Launch the harness on a prompt with defaults, then open the workspace in VS Code. */
  private async startAgent(
    project: Project,
    harness: "claude" | "codex",
    join: WorktreeJoin | null,
  ): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      title: newSessionTitle(project, join),
      prompt: "What should the agent do? Empty opens the harness without a prompt.",
      ignoreFocusOut: true,
    });
    if (prompt === undefined) return;
    if (prompt.trim().startsWith("-")) {
      void vscode.window.showErrorMessage(
        "A prompt cannot start with '-'. The harness would read it as a flag.",
      );
      return;
    }
    try {
      const session = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${harness}…` },
        async (progress) => {
          const created = await this.createSessionSafely(project, harness, join);
          const launched = await this.client.launchSession(
            created.id,
            prompt.trim() === "" ? {} : { prompt: prompt.trim() },
          );
          // The server answers a long launch before it ends; follow it until the agent runs.
          await this.client.untilStarted(launched, (line) => progress.report({ message: line }));
          return created;
        },
      );
      this.store.refresh();
      await this.open(session.id, "new-window");
    } catch (cause) {
      void showError(cause);
    }
  }

  /** The base for quick flows — the open window's branch when it IS the project; else the default. */
  private async quietBase(project: Project): Promise<string | null> {
    const branch =
      this.store.windowProject()?.project.id === project.id
        ? await currentBranch(this.store.windowProject()?.folder)
        : null;
    return branch;
  }

  /**
   * Create with the quietly inferred base; when the store does not know that ref (a local
   * branch never pushed), fall back to the project default instead of failing the quick path.
   */
  private async createSessionSafely(
    project: Project,
    harness: string,
    join: WorktreeJoin | null,
  ): Promise<Session> {
    // A join takes the worktree's own base — sending another is refused, never re-based.
    if (join !== null) return this.client.createSession(project.id, harness, null, null, join.name);
    const base = await this.quietBase(project);
    if (base === null) return this.client.createSession(project.id, harness, null, null);
    try {
      return await this.client.createSession(project.id, harness, null, base);
    } catch {
      void vscode.window.setStatusBarMessage(
        `Mend: base ${base} is not in the project store — starting from the default branch`,
        5_000,
      );
      return this.client.createSession(project.id, harness, null, null);
    }
  }

  async showQuickPick(): Promise<void> {
    const project = await this.pickProject();
    if (project === null) return;
    const detail = await this.client.projectDetail(project.id);
    const capability = await capabilitiesOf(this.client, this.store, detail.sessions);
    const sessions: OfferPick[] = detail.sessions
      .toSorted((left, right) => {
        if (left.status === "waiting" && right.status !== "waiting") return -1;
        if (right.status === "waiting" && left.status !== "waiting") return 1;
        return right.createdAt.localeCompare(left.createdAt);
      })
      .map((session) =>
        offerPick(session, capability(session), {
          label: `${session.status === "waiting" ? "$(bell-dot)" : "$(circle-filled)"} ${displaySession(session)}`,
          line: lineOf(this.store, session),
          detail: session.branch,
        }),
      );
    const actions: ActionPick[] = [
      { label: "$(add) New session…", action: "new-session" },
      { label: "$(link-external) Open in Mend", action: "open-mend" },
    ];
    const picked = await vscode.window.showQuickPick<ScopePick>([...sessions, ...actions], {
      title: `Mend · ${project.name}`,
      placeHolder: "Open a session or start something new",
      ignoreFocusOut: true,
    });
    if (picked === undefined) return;
    if (picked.action === "session") {
      await this.act(
        { kind: "session", project, session: picked.session },
        picked.offer,
        "follow-setting",
      );
    } else if (picked.action === "new-session") {
      await this.newSession({ kind: "project", project } satisfies ProjectNode);
    } else {
      await this.openInMend({ kind: "project", project } satisfies ProjectNode);
    }
  }

  async openFromUri(uri: vscode.Uri): Promise<void> {
    if (uri.path !== "/open") return;
    const sessionId = new URLSearchParams(uri.query).get("session");
    if (sessionId === null || sessionId === "") {
      await vscode.commands.executeCommand("workbench.view.extension.mend");
      return;
    }
    await this.open(sessionId, "follow-setting");
  }

  private async pickProject(argument?: unknown): Promise<Project | null> {
    if (isProjectNode(argument)) return argument.project;
    if (isSessionNode(argument)) return argument.project;
    const current = this.store.windowProject();
    if (current !== null) return current.project;
    try {
      const projects = await this.client.listProjects();
      const item = await vscode.window.showQuickPick<ProjectPick>(
        projects.map((project) => ({
          label: project.name,
          description: project.defaultBranch,
          project,
        })),
        { title: "Choose a Mend project", ignoreFocusOut: true },
      );
      return item?.project ?? null;
    } catch (cause) {
      void showError(cause);
      return null;
    }
  }

  private async sessionLocation(
    argument?: unknown,
    choose: (project: Project, sessions: ReadonlyArray<Session>) => Promise<Session | null> = (
      project,
      sessions,
    ) => this.chooseSession(project, sessions),
  ): Promise<SessionLocation | null> {
    if (isSessionNode(argument)) {
      // A row VS Code kept from an earlier read: the session as the store read it last.
      const { project, session } = this.store.find(argument.session.id) ?? argument;
      return { project, session, worktreePath: worktreePath(project, session) };
    }
    if (typeof argument === "string") {
      const found = await this.store.locate(argument);
      return found === null
        ? null
        : {
            ...found,
            worktreePath: worktreePath(found.project, found.session),
          };
    }
    const here = this.workspaceWindow.session();
    if (here !== null) return { ...here, worktreePath: worktreePath(here.project, here.session) };
    const project = this.store.windowProject()?.project ?? null;
    if (project === null) return null;
    const detail = await this.client.projectDetail(project.id);
    const session = await choose(project, detail.sessions);
    return session === null
      ? null
      : { project, session, worktreePath: worktreePath(project, session) };
  }

  private async chooseSession(
    project: Project,
    sessions: ReadonlyArray<Session>,
  ): Promise<Session | null> {
    const picked = await vscode.window.showQuickPick<SessionPick>(
      sessions.map((session) => ({
        label: displaySession(session),
        description: lineOf(this.store, session),
        action: "session",
        session,
      })),
      { title: `Choose a session · ${project.name}`, ignoreFocusOut: true },
    );
    return picked?.session ?? null;
  }

  /** Set up workspace SSH for this client and its configured Mend server, from the palette. */
  async setupWorkspaceSsh(): Promise<void> {
    try {
      await setUpWorkspaceSsh(this.context, this.client);
      void vscode.window.setStatusBarMessage(
        "Mend SSH config saved; client key registered. Host trust not checked.",
        7_000,
      );
    } catch (cause) {
      void showError(cause);
    }
  }
}

/**
 * What the extension exports (`vscode.extensions.getExtension("sealant-sh.mend").exports`): the
 * tree's current read, the way the view shows it. The editor acceptance suite reads it to see
 * that live events reached the view (apps/vscode/test/e2e).
 */
export interface MendExtensionApi {
  readonly projects: () => Promise<ReadonlyArray<ProjectDetail>>;
  /** The latest "bring my editor" pass in this window, once it settles. */
  readonly workspaceEditor: () => Promise<WorkspaceEditorReport>;
}

/** A session row was selected: the review PR hangs the Change section off this. */
export const onSessionSelected = (_node: SessionNode): void => {};

export function activate(context: vscode.ExtensionContext): MendExtensionApi {
  const connections = new ConnectionStore(context);
  const client = new MendClient(connections);
  const role = windowRole(
    vscode.env.remoteName,
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.authority),
  );
  const intents = new OpenIntents(path.join(context.globalStorageUri.fsPath, "open-intents"));
  const workspaceWindow = new WorkspaceWindow(
    client,
    role,
    intents,
    (cause) => void showError(cause),
  );
  const store = new SessionStore(context, client, role, workspaceWindow);
  const tree = new MendTreeProvider(store, client);
  const statusBar = new MendStatusBar();
  const launches = new Launches(client, store);
  const notifier = new Notifier(
    store,
    new ToastClaims(path.join(context.globalStorageUri.fsPath, "toasts")),
    launches,
  );
  const opens = openRunner({
    context,
    client,
    workspaceWindow,
    intents,
    // Who she is is read at the gesture: a failed read in the tree's snapshot must not decide.
    capability: async (session) => {
      const viewer = await client.viewerId();
      const unnamed = rowCapability({ session, viewer, members: [] });
      return unnamed.kind === "notYours"
        ? rowCapability({ session, viewer, members: await client.memberNames() })
        : unnamed;
    },
  });
  const commands = new MendCommands(
    context,
    connections,
    client,
    store,
    workspaceWindow,
    opens.runner,
  );
  const view = vscode.window.createTreeView("mend.sessions", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    store,
    view,
    statusBar,
    workspaceWindow,
    opens.disposable,
    store.onDidChange((change) => {
      const { next } = change;
      tree.changed(next);
      if (store.hasRead() || next.offline || store.error() !== null) statusBar.update(next);
      view.badge =
        next.badge === 0
          ? undefined
          : {
              value: next.badge,
              tooltip: `${next.badge} ${next.badge === 1 ? "session needs" : "sessions need"} you`,
            };
      view.message = next.message ?? "";
      notifier.changed(change);
    }),
    view.onDidChangeVisibility((event) => store.setVisible(event.visible)),
    view.onDidChangeSelection((event) => {
      store.select(event.selection.flatMap((node) => sessionIdOf(node) ?? []));
      const [node] = event.selection;
      if (event.selection.length === 1 && isSessionNode(node)) onSessionSelected(node);
    }),
    vscode.commands.registerCommand("mend.refresh", () => store.refresh()),
    vscode.commands.registerCommand("mend.connect", async () => {
      if (await commands.connect()) store.start();
    }),
    vscode.commands.registerCommand("mend.adoptProject", () => commands.adoptProject()),
    vscode.commands.registerCommand("mend.open", (argument?: unknown) =>
      commands.open(argument, "follow-setting"),
    ),
    vscode.commands.registerCommand("mend.openInNewWindow", (argument?: unknown) =>
      commands.open(argument, "new-window"),
    ),
    vscode.commands.registerCommand("mend.answer", (argument?: unknown) =>
      commands.answer(argument),
    ),
    vscode.commands.registerCommand("mend.pickSession", () => commands.pickSession()),
    vscode.commands.registerCommand("mend.newSessionInWorktree", (argument?: unknown) =>
      commands.newSessionInWorktree(argument),
    ),
    vscode.commands.registerCommand("mend.openInMend", (argument?: unknown) =>
      commands.openInMend(argument),
    ),
    vscode.commands.registerCommand("mend.setupWorkspaceSsh", () => commands.setupWorkspaceSsh()),
    vscode.commands.registerCommand("mend.copyWorktreePath", (argument?: unknown) =>
      commands.copyWorktreePath(argument),
    ),
    vscode.commands.registerCommand("mend.stopSession", (argument?: unknown) =>
      commands.stopSession(argument),
    ),
    vscode.commands.registerCommand("mend.newSession", (argument?: unknown) =>
      commands.newSession(argument),
    ),
    vscode.commands.registerCommand("mend.showQuickPick", () => commands.showQuickPick()),
    vscode.commands.registerCommand("mend.openTerminal", (argument?: unknown) =>
      commands.openTerminal(argument),
    ),
    vscode.commands.registerCommand("mend.watchTerminal", (argument?: unknown) =>
      commands.openTerminal(argument),
    ),
    vscode.commands.registerCommand("mend.reviewChange", (argument?: unknown) =>
      commands.reviewChange(argument),
    ),
    vscode.commands.registerCommand("mend.signOut", async () => {
      await commands.signOut();
      store.start();
    }),
    vscode.window.registerUriHandler({ handleUri: (uri) => commands.openFromUri(uri) }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mend.serverUrl")) store.start();
      else if (event.affectsConfiguration("mend")) store.refresh();
    }),
  );

  store.setVisible(view.visible);
  store.start();
  workspaceWindow.start();
  const editor = startWorkspaceEditor(context);
  return {
    projects: async () => store.details(),
    workspaceEditor: () => editor.settled(),
  };
}

export function deactivate(): void {}
