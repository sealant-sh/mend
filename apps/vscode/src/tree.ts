import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import { mayStop, rowContextValue, type RowCapability } from "./session-capability.js";
import { sessionLines, workspaceReads } from "./session-lines.js";
import {
  othersLine,
  type ProjectRows,
  type SessionView,
  type ViewGroup,
  type WindowModel,
  type Word,
} from "./session-model.js";
import type { SessionStore } from "./session-store.js";
import type { Project, Session } from "./types.js";

type GroupKind = ViewGroup["kind"];

type GroupNode = { readonly kind: "group"; readonly group: ViewGroup };
export type ProjectNode = { readonly kind: "project"; readonly project: Project };
type ProjectRowsNode = {
  readonly kind: "project-rows";
  readonly group: GroupKind;
  readonly rows: ProjectRows;
};
export type SessionNode = {
  readonly kind: "session";
  readonly project: Project;
  readonly session: Session;
};
/** A session as a row of the view: where it sits, and how it reads. */
type RowNode = SessionNode & {
  readonly view: SessionView;
  readonly place: string;
  /** A workspace window's own session: its row is its line, the view's title is its name. */
  readonly own: boolean;
};
type OthersNode = { readonly kind: "others"; readonly line: string };
type MessageNode = { readonly kind: "message"; readonly label: string; readonly detail?: string };
export type MendNode =
  | GroupNode
  | ProjectNode
  | ProjectRowsNode
  | RowNode
  | OthersNode
  | MessageNode;

const GROUP_LABELS: Readonly<Record<GroupKind, string>> = {
  needs: "Needs you",
  since: "Since you last looked",
  running: "Running",
  projects: "Projects",
};

/** A session's tooltip: where it is, then what it says about its workspace, a line each. */
export const sessionTooltip = (
  project: Project,
  session: Session,
  lines: ReadonlyArray<string>,
): string => [`${project.name} · ${session.branch}`, ...lines].join("\n");

const whyLine = (capability: RowCapability): ReadonlyArray<string> =>
  capability.kind === "open" ? [] : [capability.why];

/** The status dot of DESIGN.md: one colour per word, contributed as a theme colour. */
export const statusColor = (word: Word): string => {
  switch (word) {
    case "waiting":
      return "mend.status.waiting";
    case "starting":
    case "running":
    case "idle":
    case "stopping":
      return "mend.status.running";
    case "completed":
    case "landed":
      return "mend.status.observed";
    case "failed":
      return "mend.status.failed";
    case "stopped":
      return "mend.status.settled";
  }
};

const dot = (word: Word): vscode.ThemeIcon =>
  new vscode.ThemeIcon(
    word === "stopped" ? "circle-large-outline" : "circle-filled",
    new vscode.ThemeColor(statusColor(word)),
  );

const rowsOfGroup = (group: ViewGroup): ReadonlyArray<SessionView> =>
  group.kind === "projects" ? group.projects.flatMap((one) => one.rows) : group.rows;

const row = (view: SessionView, place: string, own = false): RowNode => ({
  kind: "session",
  project: view.project,
  session: view.session,
  view,
  place,
  own,
});

/** The Mend view: it maps the store's model, and reads only what a hovered row's tooltip needs. */
export class MendTreeProvider implements vscode.TreeDataProvider<MendNode> {
  readonly #changed = new vscode.EventEmitter<MendNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.#changed.event;

  constructor(
    private readonly store: SessionStore,
    private readonly client: MendClient,
  ) {}

  /** The model changed: every row may read differently. */
  changed(): void {
    this.#changed.fire();
  }

  getTreeItem(element: MendNode): vscode.TreeItem {
    switch (element.kind) {
      case "group": {
        const item = new vscode.TreeItem(
          GROUP_LABELS[element.group.kind],
          element.group.kind === "projects"
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `group:${element.group.kind}`;
        item.description = String(
          element.group.kind === "projects"
            ? element.group.projects.length
            : rowsOfGroup(element.group).length,
        );
        item.contextValue = `mend.group.${element.group.kind}`;
        return item;
      }
      case "project-rows":
      case "project": {
        const project = element.kind === "project" ? element.project : element.rows.project;
        const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${element.kind === "project" ? "projects" : element.group}:project:${project.id}`;
        item.description =
          element.kind === "project-rows"
            ? String(element.rows.rows.length)
            : project.defaultBranch;
        item.tooltip = project.originUrl ?? project.storePath;
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "mend.project";
        return item;
      }
      case "session": {
        const { view } = element;
        const item = new vscode.TreeItem(
          element.own ? view.line : view.name,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = `${element.place}:${view.session.id}`;
        if (!element.own) item.description = view.line;
        item.tooltip = this.#tooltip(view, []);
        item.iconPath = dot(view.word);
        const steer = mayStop(view.session, this.store.viewer());
        item.contextValue = `${rowContextValue(view.session, view.capability, steer)}${view.needsYou ? ".needs" : ""}`;
        return item;
      }
      case "others": {
        const item = new vscode.TreeItem(element.line, vscode.TreeItemCollapsibleState.None);
        item.id = "others";
        item.command = { command: "mend.pickSession", title: "Choose a session" };
        item.contextValue = "mend.others";
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

  #tooltip(view: SessionView, lines: ReadonlyArray<string>): string {
    return sessionTooltip(view.project, view.session, [
      view.line,
      ...lines,
      ...whyLine(view.capability),
      ...(this.store.model()?.offline === true ? ["Mend is offline"] : []),
    ]);
  }

  /**
   * A live session's tooltip, read when it is hovered: the waiting line and the retirement line
   * cost a request each, so they are read only for the hovered row, and only where the row says
   * they are worth it (`workspaceReads`).
   */
  async resolveTreeItem(item: vscode.TreeItem, element: MendNode): Promise<vscode.TreeItem> {
    if (element.kind !== "session" || !element.view.live) return item;
    const reads = workspaceReads(element.session);
    const [waitLine, retirement] = await Promise.all([
      reads.waiting ? this.client.waitLine(element.session.id) : null,
      reads.retirement ? this.client.workspaceRetirement(element.session.id) : null,
    ]);
    const members =
      retirement === null || retirement.launcher === null ? [] : await this.client.memberNames();
    item.tooltip = this.#tooltip(
      element.view,
      sessionLines({
        session: element.session,
        viewer: this.store.viewer(),
        waitLine,
        retirement,
        members,
      }),
    );
    return item;
  }

  getChildren(element?: MendNode): Array<MendNode> {
    const model = this.store.model();
    if (element === undefined) return model === null ? this.#notRead() : this.#roots(model);
    switch (element.kind) {
      case "group": {
        const { group } = element;
        if (group.kind === "projects")
          return group.projects.map(
            (one): ProjectNode => ({ kind: "project", project: one.project }),
          );
        if (group.kind === "since" && group.byProject !== null)
          return group.byProject.map(
            (rows): ProjectRowsNode => ({ kind: "project-rows", group: "since", rows }),
          );
        return group.rows.map((view) => row(view, group.kind));
      }
      case "project-rows":
        return element.rows.rows.map((view) => row(view, `${element.group}:${view.project.id}`));
      case "project": {
        if (model === null || model.kind !== "local") return [];
        const projects = model.groups.find((group) => group.kind === "projects");
        const rows =
          projects?.kind === "projects"
            ? (projects.projects.find((one) => one.project.id === element.project.id)?.rows ?? [])
            : [];
        return rows.map((view) => row(view, `projects:${view.project.id}`));
      }
      default:
        return [];
    }
  }

  #notRead(): Array<MendNode> {
    const error = this.store.error();
    return error === null
      ? []
      : [
          {
            kind: "message",
            label: error instanceof Error ? error.message : "Could not read Mend.",
            detail: "Run Mend: Connect to server",
          },
        ];
  }

  #roots(model: WindowModel): Array<MendNode> {
    const error = this.store.error();
    const errorRow: ReadonlyArray<MendNode> =
      error === null
        ? []
        : [
            {
              kind: "message",
              label: error instanceof Error ? error.message : "Could not read Mend.",
              detail: "Run Mend: Connect to server",
            },
          ];
    if (model.kind === "local")
      return [...errorRow, ...model.groups.map((group): GroupNode => ({ kind: "group", group }))];
    const own = model.session;
    return [
      ...errorRow,
      ...(own === null
        ? []
        : own.needsYou
          ? [{ kind: "group", group: { kind: "needs", rows: [own] } } satisfies GroupNode]
          : [row(own, "own", true)]),
      { kind: "others", line: othersLine(model.others) },
    ];
  }
}

export const isSessionNode = (value: unknown): value is SessionNode =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "session" &&
  typeof Reflect.get(value, "session") === "object";

export const isProjectNode = (value: unknown): value is ProjectNode =>
  typeof value === "object" && value !== null && Reflect.get(value, "kind") === "project";

/** The session a row stands for, by id, for the view's selection. */
export const sessionIdOf = (node: MendNode): string | null =>
  node.kind === "session" ? node.session.id : null;
