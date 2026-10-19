import * as path from "node:path";

import {
  emptyHarnessModelCatalog,
  modelPicker,
  repositoryCloneUrlIssue,
} from "@mend/domain/workbench";
import * as vscode from "vscode";

import { attachTerminal, maySteer, memberName, ownsSession } from "./agent-terminal.js";
import { MendApiError, MendClient, normalizeProjectName } from "./client.js";
import { ConnectionStore } from "./config.js";
import { currentBranch, pathContains, repositoryFacts, worktreePath } from "./git.js";
import { modelPickRows } from "./model-picks.js";
import { OFFER_COMMANDS, openRunner, setUpWorkspaceSsh } from "./open-command.js";
import type { OpenMode } from "./open-flow.js";
import type { OpenRunner } from "./open-runner.js";
import {
  pickDescription,
  rowCapability,
  rowOffer,
  type RowCapability,
  type RowOffer,
} from "./session-capability.js";
import { displaySession, joinLineOf, liveSessionLines } from "./session-lines.js";
import {
  MendTreeProvider,
  isProjectNode,
  isSessionNode,
  type ProjectNode,
  type SessionNode,
} from "./tree.js";
import { attachableProcesses, type TtyAddress } from "./tty-protocol.js";
import type {
  Effort,
  LaunchStart,
  Project,
  ProjectDetail,
  Session,
  SessionLocation,
  WorktreeJoin,
} from "./types.js";
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

class WorkspaceScope implements vscode.Disposable {
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  private location: SessionLocation | null = null;
  private project: Project | null = null;
  private detail: ProjectDetail | null = null;
  private folder: vscode.WorkspaceFolder | null = null;

  constructor(
    private readonly client: MendClient,
    private readonly onProject: (projectId: string | null) => void,
  ) {
    this.status.command = "mend.showQuickPick";
    this.status.name = "Mend";
  }

  dispose(): void {
    this.status.dispose();
  }

  currentProject(): Project | null {
    return this.project;
  }

  currentDetail(): ProjectDetail | null {
    return this.detail;
  }

  currentLocation(): SessionLocation | null {
    return this.location;
  }

  currentFolder(): vscode.WorkspaceFolder | null {
    return this.folder;
  }

  async refresh(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.clear();
      return;
    }
    try {
      let matched: {
        readonly detail: ProjectDetail;
        readonly folder: vscode.WorkspaceFolder;
        readonly session: Session | undefined;
      } | null = null;
      for (const folder of folders) {
        const facts = await repositoryFacts(folder);
        const resolution = await this.client.resolveProject(facts);
        if (resolution.status !== "matched") continue;
        const detail = await this.client.projectDetail(resolution.project.id);
        const session = detail.sessions.find((candidate) =>
          pathContains(facts.path, worktreePath(detail.project, candidate)),
        );
        matched = { detail, folder, session };
        if (session !== undefined) break;
      }
      if (matched === null) {
        this.clear();
        return;
      }
      const { detail, folder, session } = matched;
      this.project = detail.project;
      this.folder = folder;
      this.detail = detail;
      this.onProject(detail.project.id);
      this.location =
        session === undefined
          ? null
          : {
              project: detail.project,
              session,
              worktreePath: worktreePath(detail.project, session),
            };
      const waiting = detail.sessions.filter((candidate) => candidate.status === "waiting").length;
      this.status.text =
        session === undefined
          ? `$(pulse) Mend: ${detail.project.name} · ${detail.sessions.length} session${detail.sessions.length === 1 ? "" : "s"}${waiting === 0 ? "" : ` · ${waiting} waiting`}`
          : `$(pulse) Mend: ${detail.project.name} › ${displaySession(session)}`;
      this.status.tooltip =
        session === undefined
          ? "Open this project's Mend sessions"
          : [
              `${session.branch} · ${session.status} · open session actions`,
              ...(liveStatuses.has(session.status) ? await this.workspaceLines(session) : []),
            ].join("\n");
      this.status.show();
    } catch {
      this.clear();
    }
  }

  /**
   * What this window's live session says about its workspace (docs/adr/0016), from its project
   * view row: the row says which reads are worth a request (`liveSessionLines`).
   */
  private async workspaceLines(session: Session): Promise<ReadonlyArray<string>> {
    return liveSessionLines(session, this.client);
  }

  private clear(): void {
    this.project = null;
    this.detail = null;
    this.folder = null;
    this.location = null;
    this.onProject(null);
    this.status.hide();
  }
}

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
  tree: MendTreeProvider,
  sessions: ReadonlyArray<Session>,
): Promise<(session: Session) => RowCapability> => {
  const viewer = tree.knownViewer() ?? (await client.viewerId());
  const named = sessions.some(
    (session) => rowCapability({ session, viewer, members: [] }).kind === "notYours",
  );
  const members = named ? await client.memberNames() : [];
  return (session) => rowCapability({ session, viewer, members });
};

const offerPick = (
  session: Session,
  capability: RowCapability,
  item: { readonly label: string; readonly detail?: string },
): OfferPick => {
  const detail = capability.kind === "notYours" ? capability.why : item.detail;
  return {
    label: item.label,
    description: pickDescription(session, capability),
    ...(detail === undefined ? {} : { detail }),
    action: "session",
    session,
    offer: rowOffer(capability),
  };
};

interface ActionPick extends vscode.QuickPickItem {
  readonly action: "new-session" | "new-worktree" | "open-mend";
}

interface SessionKindPick extends vscode.QuickPickItem {
  readonly sessionKind: "workbench" | "claude" | "codex" | "advanced";
}

interface HarnessPick extends vscode.QuickPickItem {
  readonly id: "claude" | "codex" | "opencode" | "pi";
}

interface ModelPick extends vscode.QuickPickItem {
  readonly model: string | null;
}

interface EffortPick extends vscode.QuickPickItem {
  readonly effort: Effort | null;
}

interface PermissionPick extends vscode.QuickPickItem {
  readonly permission: "ask" | "bypass";
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

class MendCommands {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionStore,
    private readonly client: MendClient,
    private readonly tree: MendTreeProvider,
    private readonly scope: WorkspaceScope,
    private readonly workspaceWindow: WorkspaceWindow,
    private readonly runner: OpenRunner,
  ) {}

  async connect(): Promise<boolean> {
    if (!(await this.connections.configure())) return false;
    this.tree.refresh();
    await this.scope.refresh();
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
      this.tree.refresh();
      await this.scope.refresh();
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
    const capability = await capabilitiesOf(this.client, this.tree, sessions);
    const picked = await vscode.window.showQuickPick<OfferPick>(
      sessions.map((session) =>
        offerPick(session, capability(session), { label: displaySession(session) }),
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
      const viewer = this.tree.knownViewer() ?? (await this.client.viewerId());
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
    this.tree.refresh();
    await this.scope.refresh();
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
      const location = this.scope.currentLocation();
      const project = this.scope.currentProject();
      const route =
        location === null
          ? project === null
            ? ""
            : `/projects/${project.id}`
          : `/sessions/${location.session.id}`;
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
    const answer = await vscode.window.showWarningMessage(
      `Stop ${displaySession(location.session)}?`,
      { modal: true, detail: "The worktree and reviewable change remain." },
      "Stop session",
    );
    if (answer !== "Stop session") return;
    try {
      await this.client.stopSession(location.session.id);
      this.tree.refresh();
      await this.scope.refresh();
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * The core loop's front door: one chooser, then at most one question, then VS Code opens
   * inside the new session's workspace. The editor-native flavor comes first — a workbench
   * (fresh worktree, shell-held workspace, you run the agent yourself and Mend observes it).
   * The six-question flow survives only behind "Agent with options…".
   */
  async newSession(argument?: unknown, join: WorktreeJoin | null = null): Promise<void> {
    const project = await this.pickProject(argument);
    if (project === null) return;
    const kind = await vscode.window.showQuickPick<SessionKindPick>(
      [
        {
          label: "$(terminal) Workbench",
          detail:
            "A fresh worktree, open in VS Code. Run claude or codex yourself in the terminal — Mend observes and records it.",
          sessionKind: "workbench",
        },
        {
          label: "$(sparkle) Claude agent",
          detail: "Mend starts Claude on your prompt; the workspace opens in VS Code alongside.",
          sessionKind: "claude",
        },
        {
          label: "$(sparkle) Codex agent",
          detail: "Mend starts Codex on your prompt; the workspace opens in VS Code alongside.",
          sessionKind: "codex",
        },
        {
          label: "$(settings-gear) Agent with options…",
          detail: "Choose harness, model, thinking, permissions, and base branch.",
          sessionKind: "advanced",
        },
      ],
      { title: newSessionTitle(project, join), ignoreFocusOut: true },
    );
    if (kind === undefined) return;
    if (kind.sessionKind === "workbench") return this.startWorkbench(project, join);
    if (kind.sessionKind === "advanced") return this.newSessionAdvanced(project, join);
    return this.startAgent(project, kind.sessionKind, join);
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
      if (!(await this.sayWhoElseRunsThere(location))) return;
      await this.newSession({ kind: "project", project: location.project } satisfies ProjectNode, {
        name,
      });
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * Where two people meet in a worktree (docs/adr/0016, decision 13): before a session starts
   * where another person's session runs, say so. False when the person turns back.
   */
  private async sayWhoElseRunsThere(location: SessionLocation): Promise<boolean> {
    const worktreeId = location.session.worktreeId;
    if (worktreeId === undefined) return true;
    const detail = await this.client.projectDetail(location.project.id);
    const line = await joinLineOf(
      detail.sessions,
      worktreeId,
      this.tree.knownViewer(),
      this.client,
    );
    if (line === null) return true;
    const answer = await vscode.window.showInformationMessage(line, { modal: true }, "New session");
    return answer === "New session";
  }

  /** The joinable name of the session's worktree; null on a pre-worktree server. */
  private async worktreeNameOf(location: SessionLocation): Promise<string | null> {
    const worktreeId = location.session.worktreeId;
    if (worktreeId === undefined) return null;
    const detail = await this.client.projectDetail(location.project.id);
    return detail.worktrees?.find((worktree) => worktree.id === worktreeId)?.name ?? null;
  }

  /** A fresh worktree with a shell holding the workspace — VS Code opens straight into it. */
  private async startWorkbench(project: Project, join: WorktreeJoin | null): Promise<void> {
    try {
      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Preparing workbench · ${project.name}…`,
        },
        async () => {
          const created = await this.createSessionSafely(project, "claude", join);
          await this.client.resumeSession(created.id, "shell");
          return created;
        },
      );
      this.tree.refresh();
      await this.scope.refresh();
      await this.open(session.id, "new-window");
    } catch (cause) {
      void showError(cause);
    }
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
      this.tree.refresh();
      await this.scope.refresh();
      await this.open(session.id, "new-window");
    } catch (cause) {
      void showError(cause);
    }
  }

  /** The base for quick flows — the open window's branch when it IS the project; else the default. */
  private async quietBase(project: Project): Promise<string | null> {
    const branch =
      this.scope.currentProject()?.id === project.id
        ? await currentBranch(this.scope.currentFolder() ?? undefined)
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

  /** The base question, prefilled with the open window's branch when it IS the project. */
  private async askBase(project: Project, title: string): Promise<string | undefined> {
    const branch =
      this.scope.currentProject()?.id === project.id
        ? await currentBranch(this.scope.currentFolder() ?? undefined)
        : null;
    return vscode.window.showInputBox({
      title,
      prompt: "Base branch or commit",
      value: branch ?? project.defaultBranch,
      ignoreFocusOut: true,
    });
  }

  private async newSessionAdvanced(project: Project, join: WorktreeJoin | null): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      title: newSessionTitle(project, join),
      prompt: "What should the session do? Leave empty to open the harness without a prompt.",
      ignoreFocusOut: true,
    });
    if (prompt === undefined || prompt.trim().startsWith("-")) {
      if (prompt?.trim().startsWith("-") === true) {
        void vscode.window.showErrorMessage(
          "A prompt cannot start with '-'. The harness would read it as a flag.",
        );
      }
      return;
    }
    const harness = await vscode.window.showQuickPick<HarnessPick>(
      [
        { label: "Claude", description: "claude", id: "claude" },
        { label: "Codex", description: "codex", id: "codex" },
        { label: "opencode", description: "opencode", id: "opencode" },
        { label: "pi", description: "pi", id: "pi" },
      ],
      { title: newSessionTitle(project, join), placeHolder: "Harness", ignoreFocusOut: true },
    );
    if (harness === undefined) return;
    // The server's catalog for the harness (docs/models-audit.md): the default first (or the
    // harness's own choice, `modelPickRows`), so a plain Enter runs what every other client runs. A
    // harness it lists nothing for asks no model.
    const catalog =
      (await this.client.harnessModels().catch(() => [])).find(
        (candidate) => candidate.harness === harness.id,
      ) ?? emptyHarnessModelCatalog(harness.id);
    const offered = modelPicker(catalog, { model: null, effort: null });
    const model = offered.hasModels
      ? await vscode.window.showQuickPick<ModelPick>(
          modelPickRows(catalog, harness.description ?? harness.id),
          {
            title: `New ${harness.description} session`,
            placeHolder: "Model",
            ignoreFocusOut: true,
          },
        )
      : { label: "", model: null };
    if (model === undefined) return;
    const picked = modelPicker(catalog, { model: model.model, effort: null });
    const effort =
      picked.efforts.length > 1
        ? await vscode.window.showQuickPick<EffortPick>(
            picked.efforts.map((row) => ({ label: row.label, effort: row.effort })),
            {
              title: `New ${harness.description} session`,
              placeHolder: "Thinking",
              ignoreFocusOut: true,
            },
          )
        : { label: "", effort: null };
    if (effort === undefined) return;
    const permissions = await vscode.window.showQuickPick<PermissionPick>(
      [
        { label: "Skip permission prompts", permission: "bypass" },
        { label: "Ask before acting", permission: "ask" },
      ],
      {
        title: `New ${harness.description} session`,
        placeHolder: "Permissions",
        ignoreFocusOut: true,
      },
    );
    if (permissions === undefined) return;
    // A joined worktree already has its base; only a fresh one asks.
    const base =
      join === null ? await this.askBase(project, `New ${harness.description} session`) : "";
    if (base === undefined) return;
    try {
      const session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting ${harness.description}…`,
        },
        async (progress) => {
          const created = await this.client.createSession(
            project.id,
            harness.id,
            null,
            base.trim() || null,
            join?.name ?? null,
          );
          const start: LaunchStart = {
            ...(prompt.trim() === "" ? {} : { prompt: prompt.trim() }),
            ...(model.model === null ? {} : { model: model.model }),
            ...(effort.effort === null ? {} : { effort: effort.effort }),
            ...(permissions.permission === "ask" ? { permissionMode: "ask" } : {}),
          };
          const launched = await this.client.launchSession(created.id, start);
          // The server answers a long launch before it ends; follow it until the agent runs.
          await this.client.untilStarted(launched, (line) => progress.report({ message: line }));
          return created;
        },
      );
      this.tree.refresh();
      await this.scope.refresh();
      await this.open({ kind: "session", project, session } satisfies SessionNode, "new-window");
    } catch (cause) {
      void showError(cause);
    }
  }

  async newManualWorktree(argument?: unknown): Promise<void> {
    const project = await this.pickProject(argument);
    if (project === null) return;
    const label = await vscode.window.showInputBox({
      title: `New worktree · ${project.name}`,
      prompt: "Name this manual change",
      ignoreFocusOut: true,
    });
    if (label === undefined || label.trim() === "") return;
    const branch =
      this.scope.currentProject()?.id === project.id
        ? await currentBranch(this.scope.currentFolder() ?? undefined)
        : null;
    const base = await vscode.window.showInputBox({
      title: `New worktree · ${project.name}`,
      prompt: "Base branch or commit",
      value: branch ?? project.defaultBranch,
      ignoreFocusOut: true,
    });
    if (base === undefined) return;
    try {
      const session = await this.client.createSession(
        project.id,
        "shell",
        label.trim(),
        base.trim() || null,
      );
      await this.client.stopSession(session.id);
      this.tree.refresh();
      await this.open(
        {
          kind: "session",
          project,
          session: { ...session, status: "stopped" },
        } satisfies SessionNode,
        "new-window",
      );
    } catch (cause) {
      void showError(cause);
    }
  }

  async showQuickPick(): Promise<void> {
    const project = this.scope.currentProject() ?? (await this.pickProject());
    if (project === null) return;
    const detail =
      this.scope.currentDetail()?.project.id === project.id
        ? this.scope.currentDetail()
        : await this.client.projectDetail(project.id);
    if (detail === null) return;
    const capability = await capabilitiesOf(this.client, this.tree, detail.sessions);
    const sessions: OfferPick[] = detail.sessions
      .toSorted((left, right) => {
        if (left.status === "waiting" && right.status !== "waiting") return -1;
        if (right.status === "waiting" && left.status !== "waiting") return 1;
        return right.createdAt.localeCompare(left.createdAt);
      })
      .map((session) =>
        offerPick(session, capability(session), {
          label: `${session.status === "waiting" ? "$(bell-dot)" : "$(circle-filled)"} ${displaySession(session)}`,
          detail: session.branch,
        }),
      );
    const actions: ActionPick[] = [
      { label: "$(add) New session…", action: "new-session" },
      { label: "$(new-folder) New worktree without an agent…", action: "new-worktree" },
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
    } else if (picked.action === "new-worktree") {
      await this.newManualWorktree({ kind: "project", project } satisfies ProjectNode);
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
    const current = this.scope.currentProject();
    if (current !== null) return current;
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
      return {
        project: argument.project,
        session: argument.session,
        worktreePath: worktreePath(argument.project, argument.session),
      };
    }
    if (typeof argument === "string") {
      const found = await this.client.findSession(argument);
      return found === null
        ? null
        : {
            ...found,
            worktreePath: worktreePath(found.project, found.session),
          };
    }
    const here = this.workspaceWindow.session();
    if (here !== null) return { ...here, worktreePath: worktreePath(here.project, here.session) };
    const current = this.scope.currentLocation();
    if (current !== null) return current;
    const project = this.scope.currentProject();
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
        description: session.status,
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
  const tree = new MendTreeProvider(client);
  const scope = new WorkspaceScope(client, (projectId) => tree.setWorkspaceProject(projectId));
  const workspaceWindow = new WorkspaceWindow(
    client,
    windowRole(
      vscode.env.remoteName,
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.authority),
    ),
    (cause) => void showError(cause),
  );
  const opens = openRunner({
    context,
    client,
    workspaceWindow,
    capability: async (session) => (await capabilitiesOf(client, tree, [session]))(session),
  });
  const commands = new MendCommands(
    context,
    connections,
    client,
    tree,
    scope,
    workspaceWindow,
    opens.runner,
  );
  const view = vscode.window.createTreeView("mend.sessions", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  let refreshTimer: NodeJS.Timeout | null = null;
  const refresh = () => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      tree.refresh();
      void scope.refresh();
    }, 150);
  };

  let eventSubscription = client.subscribe(refresh);
  const restartEvents = () => {
    eventSubscription.dispose();
    eventSubscription = client.subscribe(refresh);
  };

  context.subscriptions.push(
    view,
    workspaceWindow,
    opens.disposable,
    view.onDidChangeSelection((event) => {
      const [node] = event.selection;
      if (event.selection.length === 1 && isSessionNode(node)) onSessionSelected(node);
    }),
    scope,
    new vscode.Disposable(() => eventSubscription.dispose()),
    vscode.commands.registerCommand("mend.refresh", refresh),
    vscode.commands.registerCommand("mend.toggleAllProjects", () => tree.toggleAllProjects()),
    vscode.commands.registerCommand("mend.connect", async () => {
      if (await commands.connect()) restartEvents();
    }),
    vscode.commands.registerCommand("mend.adoptProject", () => commands.adoptProject()),
    vscode.commands.registerCommand("mend.open", (argument?: unknown) =>
      commands.open(argument, "follow-setting"),
    ),
    vscode.commands.registerCommand("mend.openInNewWindow", (argument?: unknown) =>
      commands.open(argument, "new-window"),
    ),
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
    vscode.commands.registerCommand("mend.newManualWorktree", (argument?: unknown) =>
      commands.newManualWorktree(argument),
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
      restartEvents();
    }),
    vscode.window.registerUriHandler({ handleUri: (uri) => commands.openFromUri(uri) }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scope.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mend.serverUrl")) restartEvents();
      if (event.affectsConfiguration("mend")) refresh();
    }),
    new vscode.Disposable(() => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    }),
  );

  void scope.refresh();
  void tree.snapshot();
  workspaceWindow.start();
  const editor = startWorkspaceEditor(context);
  return {
    projects: async () => [...(await tree.snapshot()).details.values()],
    workspaceEditor: () => editor.settled(),
  };
}

export function deactivate(): void {}
