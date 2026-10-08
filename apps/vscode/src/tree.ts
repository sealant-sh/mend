import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import { readProjects, sessionLines, workspaceReads } from "./session-lines.js";
import type { Project, ProjectDetail, Session } from "./types.js";

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

type GroupNode = { readonly kind: "group"; readonly group: "needs" | "projects" };
export type ProjectNode = { readonly kind: "project"; readonly project: Project };
export type SessionNode = {
  readonly kind: "session";
  readonly project: Project;
  readonly session: Session;
};
type MessageNode = { readonly kind: "message"; readonly label: string; readonly detail?: string };
export type MendNode = GroupNode | ProjectNode | SessionNode | MessageNode;

interface Snapshot {
  readonly projects: ReadonlyArray<Project>;
  readonly details: ReadonlyMap<string, ProjectDetail>;
  /** Who reads the tree: the shared workspace line names everyone else. */
  readonly viewer: string | null;
}

/** A session's tooltip: where it is, then what it says about its workspace, a line each. */
export const sessionTooltip = (
  project: Project,
  session: Session,
  lines: ReadonlyArray<string>,
): string => [`${project.name} · ${session.branch} · ${session.status}`, ...lines].join("\n");

const sessionLabel = (session: Session): string =>
  session.label ?? `${session.harness} · ${session.id.slice(0, 8)}`;

const statusIcon = (status: string): vscode.ThemeIcon => {
  switch (status) {
    case "waiting":
      return new vscode.ThemeIcon(
        "bell-dot",
        new vscode.ThemeColor("notificationsWarningIcon.foreground"),
      );
    case "starting":
    case "running":
    case "idle":
      return new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.blue"));
    case "completed":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
};

/** Native VS Code tree for Mend's attention list and adopted projects. */
export class MendTreeProvider implements vscode.TreeDataProvider<MendNode> {
  private readonly changed = new vscode.EventEmitter<MendNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private current: Snapshot | null = null;
  private loading: Promise<Snapshot> | null = null;
  private error: string | null = null;
  private workspaceProjectId: string | null = null;
  private showingAllProjects = false;

  constructor(private readonly client: MendClient) {}

  setWorkspaceProject(projectId: string | null): void {
    if (projectId !== this.workspaceProjectId) this.showingAllProjects = false;
    this.workspaceProjectId = projectId;
    void vscode.commands.executeCommand(
      "setContext",
      "mend.hasWorkspaceProject",
      projectId !== null,
    );
    void vscode.commands.executeCommand(
      "setContext",
      "mend.projectScoped",
      this.activeProjectId() !== null,
    );
    this.changed.fire();
  }

  toggleAllProjects(): void {
    if (this.workspaceProjectId === null) return;
    this.showingAllProjects = !this.showingAllProjects;
    void vscode.commands.executeCommand(
      "setContext",
      "mend.projectScoped",
      this.activeProjectId() !== null,
    );
    this.changed.fire();
  }

  private activeProjectId(): string | null {
    return this.showingAllProjects ? null : this.workspaceProjectId;
  }

  refresh(): void {
    this.current = null;
    this.loading = null;
    this.error = null;
    this.changed.fire();
  }

  /** The viewer the last snapshot read, without a request; null when it read none. */
  knownViewer(): string | null {
    return this.current?.viewer ?? null;
  }

  async snapshot(): Promise<Snapshot> {
    if (this.current !== null) return this.current;
    if (this.loading !== null) return this.loading;
    this.loading = this.load();
    try {
      this.current = await this.loading;
      return this.current;
    } finally {
      this.loading = null;
    }
  }

  private async load(): Promise<Snapshot> {
    try {
      // The project view carries who is live and the retirement's state (docs/adr/0016); the
      // viewer is asked for only when a row has something per-person to say.
      const { projects, details, viewer } = await readProjects(this.client);
      this.error = null;
      await vscode.commands.executeCommand("setContext", "mend.hasProjects", projects.length > 0);
      return {
        projects,
        details: new Map(details.map((detail) => [detail.project.id, detail])),
        viewer,
      };
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "Could not read Mend.";
      await vscode.commands.executeCommand("setContext", "mend.hasProjects", true);
      return { projects: [], details: new Map(), viewer: null };
    }
  }

  getTreeItem(element: MendNode): vscode.TreeItem {
    switch (element.kind) {
      case "group": {
        const item = new vscode.TreeItem(
          element.group === "needs" ? "Needs you" : "Projects",
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(element.group === "needs" ? "bell" : "repo");
        item.contextValue = `mend.group.${element.group}`;
        return item;
      }
      case "project": {
        const item = new vscode.TreeItem(
          element.project.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = element.project.defaultBranch;
        item.tooltip = element.project.originUrl ?? element.project.storePath;
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "mend.project";
        return item;
      }
      case "session": {
        const item = new vscode.TreeItem(
          sessionLabel(element.session),
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = element.session.status;
        item.tooltip = sessionTooltip(
          element.project,
          element.session,
          sessionLines({
            session: element.session,
            viewer: this.current?.viewer ?? null,
            waitLine: null,
            retirement: null,
            members: [],
          }),
        );
        item.iconPath = statusIcon(element.session.status);
        item.contextValue = LIVE_STATUSES.has(element.session.status)
          ? "mend.session.live"
          : "mend.session.settled";
        item.command = {
          command: "mend.openWorktree",
          title: "Open in VS Code",
          arguments: [element],
        };
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        if (element.detail !== undefined) item.description = element.detail;
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
    }
  }

  /**
   * A live session's tooltip, read when it is hovered: the waiting line and the retirement line
   * cost a request each, so the tree does not read them for every row on every refresh, and
   * asks only for those the row says are worth it (`workspaceReads`).
   */
  async resolveTreeItem(item: vscode.TreeItem, element: MendNode): Promise<vscode.TreeItem> {
    if (element.kind !== "session" || !LIVE_STATUSES.has(element.session.status)) return item;
    const reads = workspaceReads(element.session);
    const [waitLine, retirement] = await Promise.all([
      reads.waiting ? this.client.waitLine(element.session.id) : null,
      reads.retirement ? this.client.workspaceRetirement(element.session.id) : null,
    ]);
    const members =
      retirement === null || retirement.launcher === null ? [] : await this.client.memberNames();
    item.tooltip = sessionTooltip(
      element.project,
      element.session,
      sessionLines({
        session: element.session,
        viewer: this.current?.viewer ?? null,
        waitLine,
        retirement,
        members,
      }),
    );
    return item;
  }

  async getChildren(element?: MendNode): Promise<MendNode[]> {
    const snapshot = await this.snapshot();
    if (element === undefined) {
      if (this.error !== null)
        return [{ kind: "message", label: this.error, detail: "Run Mend: Connect to server" }];
      if (snapshot.projects.length === 0) return [];
      const activeProjectId = this.activeProjectId();
      const waiting = [...snapshot.details.values()].some(
        (detail) =>
          (activeProjectId === null || detail.project.id === activeProjectId) &&
          detail.sessions.some((session) => session.status === "waiting"),
      );
      return [
        ...(waiting ? [{ kind: "group", group: "needs" } satisfies GroupNode] : []),
        { kind: "group", group: "projects" },
      ];
    }
    if (element.kind === "group" && element.group === "needs") {
      const activeProjectId = this.activeProjectId();
      return [...snapshot.details.values()]
        .filter((detail) => activeProjectId === null || detail.project.id === activeProjectId)
        .flatMap((detail) =>
          detail.sessions
            .filter((session) => session.status === "waiting")
            .map((session): SessionNode => ({ kind: "session", project: detail.project, session })),
        )
        .toSorted((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    }
    if (element.kind === "group" && element.group === "projects") {
      const activeProjectId = this.activeProjectId();
      return snapshot.projects
        .filter((project) => activeProjectId === null || project.id === activeProjectId)
        .map((project): ProjectNode => ({ kind: "project", project }));
    }
    if (element.kind === "project") {
      const sessions = snapshot.details.get(element.project.id)?.sessions ?? [];
      return sessions
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((session): SessionNode => ({ kind: "session", project: element.project, session }));
    }
    return [];
  }
}

export const isSessionNode = (value: unknown): value is SessionNode =>
  typeof value === "object" && value !== null && Reflect.get(value, "kind") === "session";

export const isProjectNode = (value: unknown): value is ProjectNode =>
  typeof value === "object" && value !== null && Reflect.get(value, "kind") === "project";

export const displaySession = sessionLabel;
