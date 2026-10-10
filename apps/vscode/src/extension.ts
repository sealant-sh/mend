import * as path from "node:path";

import {
  canSteerSession,
  emptyHarnessModelCatalog,
  modelPicker,
  repositoryCloneUrlIssue,
} from "@mend/domain/workbench";
import { parseWorkspaceSshTarget } from "@mend/workspace-ssh";
import * as vscode from "vscode";

import { MendApiError, MendClient, normalizeProjectName } from "./client.js";
import { ConnectionStore } from "./config.js";
import { currentBranch, pathContains, repositoryFacts, worktreePath } from "./git.js";
import { modelPickRows } from "./model-picks.js";
import { joinLineOf, liveSessionLines } from "./session-lines.js";
import {
  agentModeLabel,
  continueCommand,
  isStalePendingTakeover,
  liveEngineAgentOf,
  pendingTakeoverFor,
  type PendingTakeover,
} from "./takeover.js";
import {
  MendTreeProvider,
  displaySession,
  isProjectNode,
  isSessionNode,
  type ProjectNode,
  type SessionNode,
} from "./tree.js";
import { isRefusal } from "./tty-attachment.js";
import { attachableProcesses, type TtyAddress } from "./tty-protocol.js";
import { MendTtyTerminal } from "./tty-terminal.js";
import type {
  Effort,
  LaunchStart,
  Project,
  ProjectDetail,
  Session,
  SessionLocation,
  SessionProcess,
  WorkspaceSshView,
  WorktreeJoin,
} from "./types.js";
import { runWorkspaceSshSetup, workspaceSshReadiness } from "./workspace-ssh.js";

const liveStatuses: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/** Global-state key carrying a takeover intent into the workspace window it opens. */
const PENDING_TAKEOVER_KEY = "mend.pendingTakeover";

/** New session title: the project, plus the worktree when the session joins one. */
const newSessionTitle = (project: Project, join: WorktreeJoin | null): string =>
  join === null ? `New session · ${project.name}` : `New session · ${project.name} › ${join.name}`;

/**
 * The remote authority this window runs under, read off its remote workspace folder (the
 * public API exposes only the remote NAME). Undefined in a local window.
 */
const windowRemoteAuthority = (): string | undefined =>
  (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.scheme === "vscode-remote")
    ?.uri.authority;

/**
 * The hand-run half of a takeover: a terminal INSIDE the workspace (in a remote window every
 * integrated terminal is remote) running the provider's own resume. Mend observes the process
 * through the mounted harness home; the session reads running again under the same
 * conversation.
 */
const runContinue = (harness: string, command: string): void => {
  const terminal = vscode.window.createTerminal({ name: `${harness} · Mend` });
  terminal.show();
  terminal.sendText(command, true);
};

const errorMessage = (cause: unknown): string =>
  cause instanceof MendApiError && cause.status === 401
    ? `${cause.message} Run Mend: Connect to server to sign in.`
    : cause instanceof MendApiError || cause instanceof Error
      ? cause.message
      : "Mend could not complete that action.";

/** Whether the server lets `viewer` steer, and so attach to the terminal of, `session`. */
const maySteer = (session: Session, viewer: string): boolean =>
  canSteerSession(
    {
      ownerUserId: session.ownerUserId,
      sharedControlEnabledAt:
        session.sharedControlEnabledAt === null ? null : new Date(session.sharedControlEnabledAt),
    },
    viewer,
  );

/** The error, with Connect offered when the server refused the token. */
const showError = async (cause: unknown): Promise<void> => {
  const action =
    cause instanceof MendApiError && cause.status === 401
      ? await vscode.window.showErrorMessage(errorMessage(cause), "Connect to server")
      : await vscode.window.showErrorMessage(errorMessage(cause));
  if (action === "Connect to server") await vscode.commands.executeCommand("mend.connect");
};

/**
 * The Remote-SSH authority of one workspace through the gateway — the authority the
 * workspace folder carries inside that window.
 */
const remoteAuthority = (
  destination: { readonly host: string; readonly usernamePrefix: string },
  workspaceId: string,
): string => `ssh-remote+${destination.usernamePrefix}-${workspaceId}@${destination.host}`;

const safeFileName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";

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

interface ActionPick extends vscode.QuickPickItem {
  readonly action: "new-session" | "new-worktree" | "open-mend";
}

interface TakeoverPick extends vscode.QuickPickItem {
  readonly takeover: boolean;
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

type ScopePick = SessionPick | ActionPick;

class MendCommands {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionStore,
    private readonly client: MendClient,
    private readonly tree: MendTreeProvider,
    private readonly scope: WorkspaceScope,
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
   * Open the session's workspace. From the tree, the quick pick, or a deep link, a session
   * whose agent Mend is running elsewhere first asks whether to open ALONGSIDE it or take it
   * over here; the opens that follow a launch from this editor skip the question.
   */
  async openWorktree(
    argument?: unknown,
    options: { readonly offerTakeover?: boolean } = {},
  ): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      if (options.offerTakeover === true && liveStatuses.has(location.session.status)) {
        const detail = await this.client.sessionDetail(location.session.id);
        const agent = liveEngineAgentOf(detail.processes);
        if (agent !== null) {
          const choice = await vscode.window.showQuickPick<TakeoverPick>(
            [
              {
                label: "$(multiple-windows) Open alongside",
                detail: `${detail.session.harness} keeps running ${agentModeLabel(agent.kind)}; the editor opens the same worktree.`,
                takeover: false,
              },
              {
                label: "$(debug-continue) Take over in the editor",
                detail:
                  "End the running agent here and continue the same conversation in the workspace terminal.",
                takeover: true,
              },
            ],
            { title: `${displaySession(location.session)} is running`, ignoreFocusOut: true },
          );
          if (choice === undefined) return;
          if (choice.takeover) {
            await this.takeOver({ ...location, session: detail.session }, agent);
            return;
          }
        }
      }
      if (!(await this.mayOpenOverSsh(location))) return;
      const workspaceUri = await this.workspaceUri(location);
      if (workspaceUri === "cancelled") return;
      await this.openNamedWorkspace(location, workspaceUri);
    } catch (cause) {
      void showError(cause);
    }
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
          `${displaySession(detail.session)} is ${await this.nameOf(detail.session.ownerUserId)}'s session. Its terminal opens for others only while its owner has shared control on.`,
        );
        return;
      }
      const owns =
        viewer === null ||
        detail.session.ownerUserId === null ||
        viewer === detail.session.ownerUserId;
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
      const processId = "process" in address ? address.process : null;
      const banner = owns
        ? `Mend · ${displaySession(detail.session)} · closing this tab detaches; the process keeps running`
        : `Mend · ${displaySession(detail.session)} · read-only: only the session's owner types here`;
      const terminal = vscode.window.createTerminal({
        name: `Mend · ${displaySession(detail.session)}`,
        pty: new MendTtyTerminal({
          connection: () => this.client.connection(),
          address,
          banner,
          liveness: async () => {
            try {
              const now = await this.client.sessionDetail(detail.session.id);
              const live =
                processId === null
                  ? now.currentAgent !== null && now.currentAgent.exitedAt === null
                  : attachableProcesses(now.processes).some((process) => process.id === processId);
              return live ? "live" : "ended";
            } catch (cause) {
              return isRefusal(cause) ? "refused" : "unknown";
            }
          },
        }),
      });
      terminal.show();
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

  /** A member's name as the organization lists it; "another person" when it cannot say. */
  private async nameOf(userId: string | null): Promise<string> {
    if (userId === null) return "another person";
    const names = await this.client.memberNames();
    return names.find((member) => member.userId === userId)?.name ?? "another person";
  }

  /**
   * Remote-SSH admits only the person who launched the workspace's executor (docs/adr/0016; the
   * gateway authorizes the workspace's creator). That is not always the session's owner: a session
   * started in a worktree where another person's session already runs joins that person's
   * executor. Opening it would end in a bare "Permission denied" from Remote-SSH, so say it first
   * and offer the terminal where the server lets this person in. Every path that opens a
   * workspace over SSH asks this, the takeover included.
   */
  private async mayOpenOverSsh(location: SessionLocation): Promise<boolean> {
    const launcher = location.session.workspaceLauncherUserId;
    const viewer = this.tree.knownViewer() ?? (await this.client.viewerId());
    if (launcher === null || viewer === null || launcher === viewer) return true;
    const terminal = maySteer(location.session, viewer);
    const answer = await vscode.window.showWarningMessage(
      `${await this.nameOf(launcher)} launched the workspace ${displaySession(location.session)} runs in.`,
      {
        modal: true,
        detail: `Remote-SSH opens a workspace only for the person who launched it, so VS Code would be refused. A session of yours in this worktree joins the same workspace, so it would be refused too.${terminal ? " The session's terminal needs no SSH." : ""}`,
      },
      ...(terminal ? ["Open terminal", "Open anyway"] : ["Open anyway"]),
    );
    if (answer === "Open terminal") {
      await this.openTerminal({
        kind: "session",
        project: location.project,
        session: location.session,
      } satisfies SessionNode);
      return false;
    }
    return answer === "Open anyway";
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

  /** Explicit takeover from the tree — the same flow the open-time question reaches. */
  async takeOverSession(argument?: unknown): Promise<void> {
    try {
      const location = await this.sessionLocation(argument);
      if (location === null) return;
      const detail = await this.client.sessionDetail(location.session.id);
      const agent = liveEngineAgentOf(detail.processes);
      if (agent === null) {
        void vscode.window.showInformationMessage(
          `${displaySession(location.session)} has no agent Mend is running — nothing to take over. Open the workspace and run the harness yourself.`,
        );
        return;
      }
      await this.takeOver({ ...location, session: detail.session }, agent);
    } catch (cause) {
      void showError(cause);
    }
  }

  /**
   * Editor-native takeover. The editor cannot adopt the engine's PTY, so it takes the observed
   * route: a shell holds the workspace lease, the stop ends the agent (a stop that ends a live
   * agent keeps its shells, so the workspace stays), and the provider's own resume runs in a
   * terminal inside the workspace — where the harness home still holds the transcript the
   * agent was writing. Mend observes that process as the same conversation.
   */
  private async takeOver(location: SessionLocation, agent: SessionProcess): Promise<void> {
    const { session } = location;
    const command = continueCommand(session.harness, agent.providerSessionId);
    if (command === null) {
      void vscode.window.showErrorMessage(
        `Mend cannot continue a ${session.harness} conversation by hand; attach from a terminal instead: mend attach ${session.id.slice(0, 8)}`,
      );
      return;
    }
    // Before ending anything: Remote-SSH must admit this person, and SSH must be set up. A refusal
    // or a cancelled setup leaves the agent running.
    if (!(await this.mayOpenOverSsh(location))) return;
    const destination = await this.resolveWorkspaceSsh(false);
    if (destination === "cancelled") return;
    const workspaceId = session.sealantWorkspaceId;
    if (workspaceId === null) {
      void vscode.window.showErrorMessage(
        `${displaySession(session)} reports no live workspace to take over.`,
      );
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Take over ${displaySession(session)} in the editor?`,
      {
        modal: true,
        detail: `Ends the ${session.harness} Mend is running ${agentModeLabel(agent.kind)}. The workspace stays open, and the same conversation resumes in its terminal with: ${command}`,
      },
      "Take over",
    );
    if (answer !== "Take over") return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Taking over ${displaySession(session)}…`,
      },
      async () => {
        await this.client.openShell(session.id);
        await this.client.stopSession(session.id);
      },
    );
    this.tree.refresh();
    await this.scope.refresh();
    const authority = remoteAuthority(destination, workspaceId);
    if (windowRemoteAuthority() === authority) {
      // Already inside this workspace's window: the terminal opens right here.
      runContinue(session.harness, command);
      return;
    }
    // The new window's extension host claims this on activation (see `activate`).
    const pending: PendingTakeover = {
      authority,
      workspaceId,
      sessionId: session.id,
      harness: session.harness,
      command,
      at: Date.now(),
    };
    await this.context.globalState.update(PENDING_TAKEOVER_KEY, pending);
    if (!(await this.ensureRemoteSsh(authority, "/workspace/repo"))) {
      await this.context.globalState.update(PENDING_TAKEOVER_KEY, undefined);
      void vscode.window.showInformationMessage(
        `${displaySession(session)} is yours: the workspace stays open. Run "${command}" in its terminal to continue the conversation.`,
      );
      return;
    }
    await this.openNamedWorkspace(
      location,
      vscode.Uri.from({ scheme: "vscode-remote", authority, path: "/workspace/repo" }),
    );
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
   * harness home), so continuing a sibling's conversation here is a takeover, not a join.
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
      await this.openWorktree(session.id);
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
      await this.openWorktree(session.id);
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
      await this.openWorktree({ kind: "session", project, session } satisfies SessionNode);
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
      await this.openWorktree({
        kind: "session",
        project,
        session: { ...session, status: "stopped" },
      } satisfies SessionNode);
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
    const sessions: SessionPick[] = detail.sessions
      .toSorted((left, right) => {
        if (left.status === "waiting" && right.status !== "waiting") return -1;
        if (right.status === "waiting" && left.status !== "waiting") return 1;
        return right.createdAt.localeCompare(left.createdAt);
      })
      .map((session) => ({
        label: `${session.status === "waiting" ? "$(bell-dot)" : "$(circle-filled)"} ${displaySession(session)}`,
        description: session.status,
        detail: session.branch,
        action: "session",
        session,
      }));
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
      await this.openWorktree(
        { kind: "session", project, session: picked.session } satisfies SessionNode,
        { offerTakeover: true },
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
    await this.openWorktree(sessionId, { offerTakeover: true });
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

  private async sessionLocation(argument?: unknown): Promise<SessionLocation | null> {
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
    const current = this.scope.currentLocation();
    if (current !== null) return current;
    const project = this.scope.currentProject();
    if (project === null) return null;
    const detail = await this.client.projectDetail(project.id);
    const picked = await vscode.window.showQuickPick<SessionPick>(
      detail.sessions.map((session) => ({
        label: displaySession(session),
        description: session.status,
        action: "session",
        session,
      })),
      { title: `Open worktree · ${project.name}`, ignoreFocusOut: true },
    );
    return picked === undefined
      ? null
      : { project, session: picked.session, worktreePath: worktreePath(project, picked.session) };
  }

  /**
   * Open the session's workspace through the published workspace SSH gateway. Host filesystem
   * paths are never a fallback: their shell would run outside the supervised workspace.
   */
  private async workspaceUri(location: SessionLocation): Promise<vscode.Uri | "cancelled"> {
    const destination = await this.resolveWorkspaceSsh(false);
    if (destination === "cancelled") return destination;
    let workspaceId = liveStatuses.has(location.session.status)
      ? location.session.sealantWorkspaceId
      : null;
    if (workspaceId === null) {
      workspaceId = await this.resumeForEditor(location);
      if (workspaceId === null) return "cancelled";
    }
    const authority = remoteAuthority(destination, workspaceId);
    if (!(await this.ensureRemoteSsh(authority, "/workspace/repo"))) return "cancelled";
    return vscode.Uri.from({
      scheme: "vscode-remote",
      authority,
      path: "/workspace/repo",
    });
  }

  /**
   * Discover the gateway and reconcile this client's exact server alias, host, port, and key.
   * Discovery and authentication failures stop the open instead of becoming host-path opens.
   */
  private async resolveWorkspaceSsh(
    force: boolean,
  ): Promise<{ readonly host: string; readonly usernamePrefix: string } | "cancelled"> {
    let view: WorkspaceSshView;
    try {
      view = await this.client.workspaceSsh();
    } catch (cause) {
      void showError(cause);
      return "cancelled";
    }
    const gateway = view.gateway;
    if (gateway === null) {
      void vscode.window.showErrorMessage("This Mend deployment exposes no workspace SSH gateway.");
      return "cancelled";
    }
    const connection = await this.client.connection();
    const hostnameOverride =
      vscode.workspace.getConfiguration("mend").get<string>("workspaceSshHost")?.trim() ?? "";
    const parsedTarget = parseWorkspaceSshTarget({
      serverUrl: connection.url,
      publishedPort: gateway.port,
      hostnameOverride,
    });
    if (!parsedTarget.ok) {
      void vscode.window.showErrorMessage(parsedTarget.error.message);
      return "cancelled";
    }
    let ready = false;
    try {
      ready = !force && workspaceSshReadiness(view, parsedTarget.value).ready;
    } catch (cause) {
      void showError(cause);
      return "cancelled";
    }
    if (!ready) {
      const answer = await vscode.window.showInformationMessage(
        "Set up workspace SSH?",
        {
          modal: true,
          detail:
            "Mend registers this machine's SSH key and manages one server-specific Host block in ~/.ssh/config. Existing hand-written config and other Mend servers are preserved. Setup does not test the SSH connection or verify gateway host trust.",
        },
        "Set up",
      );
      if (answer !== "Set up") return "cancelled";
      try {
        await runWorkspaceSshSetup(parsedTarget.value, (publicKey, name) =>
          this.client.ensureWorkspaceSshKey(publicKey, name),
        );
        void vscode.window.setStatusBarMessage(
          "Mend SSH config saved; client key registered. Host trust not checked.",
          7_000,
        );
      } catch (cause) {
        void showError(cause);
        return "cancelled";
      }
    }
    return { host: parsedTarget.value.alias, usernamePrefix: gateway.usernamePrefix };
  }

  /** Reconcile workspace SSH for this client and its currently configured Mend server. */
  async setupWorkspaceSsh(): Promise<void> {
    await this.resolveWorkspaceSsh(true);
  }

  /**
   * A settled session has no live workspace to attach to. Offer a SHELL resume: it provisions
   * a fresh workspace over the same worktree and the shell holds the lease while the editor
   * is attached — no agent is launched. Resolves the new workspace id, or null.
   */
  private async resumeForEditor(location: SessionLocation): Promise<string | null> {
    const answer = await vscode.window.showInformationMessage(
      `${displaySession(location.session)} has no live workspace.`,
      {
        modal: true,
        detail:
          "Resume it as a workbench shell and open the workspace? The shell keeps the workspace alive while the editor is attached; an agent you run inside is observed by Mend.",
      },
      "Resume and open",
    );
    if (answer !== "Resume and open") return null;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Resuming ${displaySession(location.session)}…`,
      },
      async () => {
        await this.client.resumeSession(location.session.id, "shell");
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const found = await this.client.findSession(location.session.id);
          const session = found?.session;
          if (
            session !== undefined &&
            session.sealantWorkspaceId !== null &&
            liveStatuses.has(session.status)
          ) {
            this.tree.refresh();
            return session.sealantWorkspaceId;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        void vscode.window.showErrorMessage(
          "The resumed session did not report a workspace in time.",
        );
        return null;
      },
    );
  }

  /** True when Microsoft Remote SSH is available; otherwise offers the install or the CLI line. */
  private async ensureRemoteSsh(authority: string, remotePath: string): Promise<boolean> {
    if (vscode.extensions.getExtension("ms-vscode-remote.remote-ssh") !== undefined) return true;
    const choice = await vscode.window.showInformationMessage(
      "Opening a remote Mend worktree requires Microsoft Remote SSH.",
      "Install Remote SSH",
      "Copy code command",
    );
    if (choice === "Install Remote SSH") {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        "ms-vscode-remote.remote-ssh",
      );
    } else if (choice === "Copy code command") {
      await vscode.env.clipboard.writeText(
        `code --remote ${authority} ${JSON.stringify(remotePath)}`,
      );
    }
    return false;
  }

  private async openNamedWorkspace(location: SessionLocation, folder: vscode.Uri): Promise<void> {
    // A remote folder opens DIRECTLY: `vscode.openFolder` on the vscode-remote URI is what
    // reliably attaches Remote-SSH. The .code-workspace wrapper (kept for local opens, where
    // it names the window) carries a `remoteAuthority` field VS Code does not always honor —
    // the failure mode is a LOCAL window pointing at a remote URI: an empty-looking folder
    // and a terminal on the wrong machine.
    if (folder.scheme === "vscode-remote") {
      await vscode.commands.executeCommand("vscode.openFolder", folder, { forceNewWindow: true });
      return;
    }
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const title = `${location.project.name} › ${displaySession(location.session)}`;
    const file = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `${safeFileName(location.project.name)}-${location.session.id.slice(0, 12)}.code-workspace`,
    );
    const document = {
      folders: [{ uri: folder.toString(true) }],
      settings: { "window.title": title },
    };
    await vscode.workspace.fs.writeFile(
      file,
      new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
    );
    await vscode.commands.executeCommand("vscode.openFolder", file, { forceNewWindow: true });
  }
}

/**
 * What the extension exports (`vscode.extensions.getExtension("sealant-sh.mend").exports`): the
 * tree's current read, the way the view shows it. The editor acceptance suite reads it to see
 * that live events reached the view (apps/vscode/test/e2e).
 */
export interface MendExtensionApi {
  readonly projects: () => Promise<ReadonlyArray<ProjectDetail>>;
}

export function activate(context: vscode.ExtensionContext): MendExtensionApi {
  const connections = new ConnectionStore(context);
  const client = new MendClient(connections);
  const tree = new MendTreeProvider(client);
  const scope = new WorkspaceScope(client, (projectId) => tree.setWorkspaceProject(projectId));
  const commands = new MendCommands(context, connections, client, tree, scope);
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
    scope,
    new vscode.Disposable(() => eventSubscription.dispose()),
    vscode.commands.registerCommand("mend.refresh", refresh),
    vscode.commands.registerCommand("mend.toggleAllProjects", () => tree.toggleAllProjects()),
    vscode.commands.registerCommand("mend.connect", async () => {
      if (await commands.connect()) restartEvents();
    }),
    vscode.commands.registerCommand("mend.adoptProject", () => commands.adoptProject()),
    vscode.commands.registerCommand("mend.openWorktree", (argument?: unknown) =>
      commands.openWorktree(argument, { offerTakeover: true }),
    ),
    vscode.commands.registerCommand("mend.takeOverSession", (argument?: unknown) =>
      commands.takeOverSession(argument),
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
  claimPendingTakeover(context);
  return { projects: async () => [...(await tree.snapshot()).details.values()] };
}

/**
 * The window a takeover opened finishes it: this extension host is the one that can create a
 * terminal inside the workspace. Claimed once, then cleared; a stale record is cleared too.
 */
const claimPendingTakeover = (context: vscode.ExtensionContext): void => {
  const stored: unknown = context.globalState.get(PENDING_TAKEOVER_KEY);
  const now = Date.now();
  const pending = pendingTakeoverFor(stored, windowRemoteAuthority(), now);
  if (pending === null) {
    if (isStalePendingTakeover(stored, now)) {
      void context.globalState.update(PENDING_TAKEOVER_KEY, undefined);
    }
    return;
  }
  void context.globalState.update(PENDING_TAKEOVER_KEY, undefined);
  runContinue(pending.harness, pending.command);
};

export function deactivate(): void {}
