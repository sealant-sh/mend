import * as path from "node:path";

import { repositoryCloneUrlIssue } from "@mend/domain/workbench";
import * as vscode from "vscode";

import { attachTerminal, memberName, pasteInto, terminalProcess } from "./agent-terminal.js";
import { RequestPrompts, requestToAnswer } from "./answer-prompt.js";
import { AUTH_PROVIDER_ID, MendAuthenticationProvider } from "./auth-provider.js";
import { MendClient } from "./client.js";
import { ConnectionStore } from "./config.js";
import { canonicalServerUrl } from "./credentials.js";
import { showErrorToast } from "./error-toast.js";
import { FirstRunTree, FirstRunView, isOfferRow } from "./first-run-view.js";
import { offerOf } from "./first-run.js";
import { worktreePath } from "./git.js";
import { HandoffInput } from "./handoff-input.js";
import { LastSeenFile } from "./last-seen.js";
import { Launches } from "./launches.js";
import { NewSessionInput } from "./new-session-input.js";
import { OFFER_COMMANDS, openRunner } from "./open-command.js";
import type { OpenMode } from "./open-flow.js";
import { OpenIntents } from "./open-intent.js";
import type { OpenRunner } from "./open-runner.js";
import { originProjectName } from "./project-match.js";
import { Answers } from "./request-answer.js";
import { pasteIntoAgent } from "./review/agent-paste.js";
import { KeptReviews } from "./review/kept-reviews.js";
import { startReview, type Review } from "./review/review.js";
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
import { SetupSessions } from "./setup-session.js";
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
import type { Project, ProjectDetail, Session, SessionLocation } from "./types.js";
import { terminalTabName, windowRole } from "./window-role.js";
import { startWorkspaceEditor, type WorkspaceEditorReport } from "./workspace-editor.js";
import { WorkspaceWindow } from "./workspace-window.js";

const liveStatuses: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Mend could not complete that action.";

/** The error, with Connect offered when the server refused the token. */
const showError = async (cause: unknown): Promise<void> => {
  await showErrorToast(cause, errorMessage(cause));
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
    private readonly connections: ConnectionStore,
    private readonly client: MendClient,
    private readonly store: SessionStore,
    private readonly workspaceWindow: WorkspaceWindow,
    private readonly runner: OpenRunner,
    private readonly newSessionInput: NewSessionInput,
    private readonly review: Review,
    private readonly prompts: RequestPrompts,
    private readonly setupSessions: SetupSessions,
  ) {}

  /** Adopt a repository…: one input for its clone URL; the project takes the repository's name. */
  async adoptProject(): Promise<void> {
    try {
      const typed = await vscode.window.showInputBox({
        title: "Adopt a repository",
        prompt: "Git clone URL",
        placeHolder: "https://github.com/owner/repository.git",
        ignoreFocusOut: true,
        validateInput: (value) => repositoryCloneUrlIssue(value.trim()),
      });
      if (typed === undefined || typed.trim() === "") return;
      const source = typed.trim();
      const project = await vscode.window.withProgress(
        { location: { viewId: "mend.sessions" } },
        () => this.client.adoptProject(originProjectName(source), source),
      );
      this.store.refresh();
      // From the palette the view may be hidden: the adopted project is what says it worked.
      await vscode.commands.executeCommand("workbench.view.extension.mend");
      await this.setupSessions.offer(project);
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
   * Answer a session that waits (rule 8): a conversation's request in a quick pick, and a terminal
   * agent's tab in this window's panel, attached or shown again. No window opens.
   */
  async answer(argument?: unknown): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      const view = this.store.model()?.sessions.get(location.session.id);
      const request = requestToAnswer(view);
      if (view !== undefined && request !== null) {
        await this.prompts.answer(request, view.name);
        return;
      }
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

  /** The session's change in the Change section, here in the editor (rule 11). */
  async reviewChange(argument?: unknown): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      await this.review.show(location.project, location.session);
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * A sign-out she chose: the store stops reading first, so a read still out on the revoked token
   * cannot come back refused and toast `Signed out — sign in again.` after it.
   */
  async signOut(url?: string): Promise<void> {
    const current = (await this.client.connection()).url;
    if (url === undefined || canonicalServerUrl(url) === current) this.store.stop();
    const said = await this.connections.signOut(url);
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

  /**
   * Mend: New session (story a): one quick input on the window's project, or the project a row
   * named, or a project she picks. Enter starts a terminal agent; no window opens.
   */
  async newSession(argument?: unknown): Promise<void> {
    const project = isProjectNode(argument) || isSessionNode(argument) ? argument.project : null;
    await this.newSessionInput.open({ project, join: null });
  }

  /**
   * Another session inside an existing worktree: the same files, a new conversation, and the
   * worktree's own base. Who else runs there is on the input's dim line.
   */
  async newSessionInWorktree(argument?: unknown): Promise<void> {
    const location = await this.sessionLocation(argument);
    if (location === null) return;
    try {
      const worktreeId = location.session.worktreeId;
      const detail =
        worktreeId === undefined ? null : await this.client.projectDetail(location.project.id);
      const worktree = detail?.worktrees?.find((candidate) => candidate.id === worktreeId);
      if (worktree === undefined) {
        void vscode.window.showErrorMessage(
          "This server does not report worktrees, so the session's worktree cannot be joined.",
        );
        return;
      }
      await this.newSessionInput.open({
        project: location.project,
        join: {
          worktree: worktree.name,
          worktreeId: worktree.id,
          // An anonymous worktree's name is `wt-<uuid>`: it goes by the session it was joined from.
          shown: /^wt-[0-9a-f-]{36}$/.test(worktree.name)
            ? `${displaySession(location.session)}'s worktree`
            : worktree.name,
        },
      });
    } catch (cause) {
      void showError(cause);
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
      { label: "$(add) New session", action: "new-session" },
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

  async setupSession(argument?: unknown): Promise<void> {
    const project = await this.pickProject(argument);
    if (project === null) return;
    try {
      await this.setupSessions.offer(project);
    } catch (cause) {
      void showError(cause);
    }
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

export function activate(context: vscode.ExtensionContext): MendExtensionApi {
  const connections = new ConnectionStore(context);
  context.subscriptions.push(connections);
  const client = new MendClient(connections);
  const role = windowRole(
    vscode.env.remoteName,
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.authority),
  );
  const intents = new OpenIntents(path.join(context.globalStorageUri.fsPath, "open-intents"));
  const kept = new KeptReviews(path.join(context.globalStorageUri.fsPath, "reviews"));
  const workspaceWindow = new WorkspaceWindow(
    client,
    role,
    intents,
    (cause) => void showError(cause),
  );
  const store = new SessionStore(new LastSeenFile(kept), client, role, workspaceWindow);
  const tree = new MendTreeProvider(store, client);
  const statusBar = new MendStatusBar();
  const launches = new Launches(store);
  const claims = new ToastClaims(path.join(context.globalStorageUri.fsPath, "toasts"));
  const prompts = new RequestPrompts(new Answers(() => client.bind()), store);
  const notifier = new Notifier(store, claims, launches, prompts);
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
  const setupSessions = new SetupSessions(client, store, launches);
  const newSessionInput = new NewSessionInput(context, client, store, launches);
  const handoffInput = new HandoffInput(context, client, store, launches, role);
  const review = startReview({
    client,
    kept,
    onError: (cause) => void showError(cause),
    claims,
    // G12 fallback: her agent's terminal attached here, as Answer attaches it, and the review
    // pasted into that agent process for her to press Enter.
    paste: (sessionId, processId, text, reads, bound) =>
      pasteIntoAgent(
        {
          detail: (id) => reads.sessionDetail(id),
          bound,
          answer: (id) => workspaceWindow.answer(id),
          // VS Code makes the attached tab the active terminal a moment after Answer shows it.
          activeTab: (id) => {
            const terminal = vscode.window.activeTerminal;
            return terminal !== undefined && workspaceWindow.terminalSession() === id
              ? terminal
              : null;
          },
          processOf: terminalProcess,
          paste: pasteInto,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        sessionId,
        processId,
        text,
      ),
  });
  const commands = new MendCommands(
    connections,
    client,
    store,
    workspaceWindow,
    opens.runner,
    newSessionInput,
    review,
    prompts,
    setupSessions,
  );
  const viewTree = new FirstRunTree(tree);
  const view = vscode.window.createTreeView("mend.sessions", {
    treeDataProvider: viewTree,
    showCollapseAll: true,
  });
  const firstRun = new FirstRunView({ context, connections, client, store, role, setupSessions });
  const connect = async (): Promise<boolean> => {
    const signedIn = await connections.connect();
    await firstRun.refresh();
    void connections.revokeReplaced();
    return signedIn;
  };
  const signOut = async (url?: string): Promise<void> => {
    await commands.signOut(url);
    await firstRun.refresh();
  };
  const accounts = new MendAuthenticationProvider({
    account: () => firstRun.account(),
    signIn: connect,
    signOut,
  });
  // VS Code draws a welcome only over an empty tree, and none while the view has a message: until
  // first run is done the sessions tree stays empty, and an offer is a message and one row.
  const drawTree = (): void => {
    const mode = firstRun.mode();
    const offer = mode.kind === "welcome" ? offerOf(mode.welcome) : null;
    viewTree.show(offer);
    tree.changed(mode.kind === "tree" ? store.model() : null);
    if (mode.kind !== "tree") review.forget();
    view.message = offer?.message ?? (mode.kind === "tree" ? (store.model()?.message ?? "") : "");
  };
  let reading: string | null = null;
  const followFirstRun = (): void => {
    const connected = firstRun.connected();
    const key = connected === null ? null : JSON.stringify(connected);
    if (key !== reading) {
      reading = key;
      if (connected === null) {
        store.stop();
        statusBar.hide();
        view.badge = undefined;
      } else {
        store.start();
        void workspaceWindow.locateAgain();
      }
    }
    drawTree();
    accounts.changed();
  };

  context.subscriptions.push(
    firstRun,
    viewTree,
    accounts,
    firstRun.onDidChange(followFirstRun),
    vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, "Mend", accounts),
    context.secrets.onDidChange(() => void firstRun.refresh()),
    connections.onDidChangeCli(() => void firstRun.refresh()),
    vscode.extensions.onDidChange(() => void firstRun.refresh()),
    vscode.commands.registerCommand("mend.connect", connect),
    vscode.commands.registerCommand("mend.useCli", () => firstRun.useCli()),
    vscode.commands.registerCommand("mend.setupWorkspaceSsh", () => firstRun.setUp()),
    vscode.commands.registerCommand("mend.skipWorkspaceSsh", () => firstRun.skipSetUp()),
    vscode.commands.registerCommand("mend.adoptHere", () => firstRun.adoptHere()),
    vscode.commands.registerCommand("mend.signOut", () => signOut()),
    store,
    view,
    statusBar,
    workspaceWindow,
    opens.disposable,
    newSessionInput,
    handoffInput,
    vscode.commands.registerCommand("mend.handoffBranch", (argument: unknown) =>
      handoffInput.open(argument),
    ),
    store.onDidChange((change) => {
      const { next } = change;
      firstRun.render();
      drawTree();
      if (store.hasRead() || next.offline || store.error() !== null) statusBar.update(next);
      view.badge =
        next.badge === 0
          ? undefined
          : {
              value: next.badge,
              tooltip: `${next.badge} ${next.badge === 1 ? "session needs" : "sessions need"} you`,
            };
      notifier.changed(change);
    }),
    view.onDidChangeVisibility((event) => store.setVisible(event.visible)),
    view.onDidChangeSelection((event) => {
      store.select(
        event.selection.flatMap((node) => (isOfferRow(node) ? [] : (sessionIdOf(node) ?? []))),
      );
      const [node] = event.selection;
      if (event.selection.length === 1 && isSessionNode(node))
        review.follow(node.project, node.session);
    }),
    review,
    store.onDidHearEvent((event) => review.heard(event)),
    // A workspace window's Change section is its own session's, selected or not (rule 10).
    store.onDidChange(({ next }) => {
      review.setOffline(next.offline);
      if (firstRun.mode().kind === "tree" && next.kind === "workspace" && next.session !== null)
        review.follow(next.session.project, next.session.session);
    }),
    vscode.commands.registerCommand("mend.refresh", () => {
      store.refresh();
      void handoffInput.refresh();
    }),
    vscode.commands.registerCommand("mend.setupSession", (argument?: unknown) =>
      commands.setupSession(argument),
    ),
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
    vscode.window.registerUriHandler({ handleUri: (uri) => commands.openFromUri(uri) }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("mend.serverUrl") ||
        event.affectsConfiguration("mend.workspaceSshHost") ||
        event.affectsConfiguration("remote.SSH.remotePlatform")
      )
        void firstRun.refresh();
      else if (event.affectsConfiguration("mend")) store.refresh();
    }),
  );

  store.setVisible(view.visible);
  void firstRun.refresh();
  workspaceWindow.start();
  const editor = startWorkspaceEditor(context, workspaceWindow);
  return {
    projects: async () => store.details(),
    workspaceEditor: () => editor.settled(),
  };
}

export function deactivate(): void {}
