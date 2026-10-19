import * as vscode from "vscode";

import type { MendClient } from "./client.js";
import { mayStop, rowContextValue, type RowCapability } from "./session-capability.js";
import { sessionLines, workspaceReads } from "./session-lines.js";
import type { SessionView, WindowModel, Word } from "./session-model.js";
import type { SessionStore } from "./session-store.js";
import {
  layoutOf,
  nodeId,
  redraws,
  ROOT,
  rowsOfGroup,
  type GroupKind,
  type Layout,
  type MendNode,
  type Placed,
} from "./tree-layout.js";
import type { Project, Session } from "./types.js";

export type { MendNode, ProjectNode, SessionNode } from "./tree-layout.js";

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

/**
 * The Mend view: it maps the store's model, and reads only what a hovered row's tooltip needs.
 * Each node keeps the object VS Code first got for its id, and every read of it goes to the
 * latest layout by that id, so a redraw can name just the nodes that moved (`redraws`).
 */
export class MendTreeProvider implements vscode.TreeDataProvider<MendNode> {
  readonly #changed = new vscode.EventEmitter<Array<MendNode> | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #layout: Layout | null = null;
  #latest = new Map<string, Placed>();
  /** The object VS Code holds for each id: a redraw of that id must name it. */
  readonly #given = new Map<string, MendNode>();

  constructor(
    private readonly store: SessionStore,
    private readonly client: MendClient,
  ) {}

  /** The model changed: redraw what moved, and nothing else. */
  changed(model: WindowModel | null): void {
    const error = this.store.error();
    const next = layoutOf({
      model,
      hasRead: this.store.hasRead(),
      error:
        error === null ? null : error instanceof Error ? error.message : "Could not read Mend.",
      viewer: this.store.viewer(),
    });
    const redraw = redraws(this.#layout, next);
    this.#layout = next;
    this.#latest = new Map([...next.values()].flat().map((placed) => [placed.id, placed]));
    for (const id of this.#given.keys()) if (!this.#latest.has(id)) this.#given.delete(id);
    if (redraw === "all") this.#changed.fire(undefined);
    else {
      const nodes = redraw.flatMap((id) => this.#given.get(id) ?? []);
      if (nodes.length > 0) this.#changed.fire(nodes);
    }
  }

  /** The node as the latest layout has it: the one VS Code passes may be from an earlier one. */
  current(element: MendNode): MendNode {
    return this.#latest.get(nodeId(element))?.node ?? element;
  }

  getTreeItem(element: MendNode): vscode.TreeItem {
    const node = this.current(element);
    switch (node.kind) {
      case "group": {
        const count =
          node.group.kind === "projects"
            ? node.group.projects.length
            : rowsOfGroup(node.group).length;
        const item = new vscode.TreeItem(
          GROUP_LABELS[node.group.kind],
          count === 0
            ? vscode.TreeItemCollapsibleState.None
            : node.group.kind === "projects"
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = nodeId(node);
        item.description = count === 0 ? "nothing" : String(count);
        item.contextValue = `mend.group.${node.group.kind}`;
        return item;
      }
      case "project-rows":
      case "project": {
        const project = node.kind === "project" ? node.project : node.rows.project;
        const item = new vscode.TreeItem(project.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = nodeId(node);
        item.description =
          node.kind === "project-rows" ? String(node.rows.rows.length) : project.defaultBranch;
        item.tooltip = project.originUrl ?? project.storePath;
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "mend.project";
        return item;
      }
      case "session": {
        const { view } = node;
        const item = new vscode.TreeItem(view.name, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        item.description = view.line;
        item.tooltip = this.#tooltip(view, []);
        item.iconPath = dot(view.word);
        const steer = mayStop(view.session, this.store.viewer());
        item.contextValue = `${rowContextValue(view.session, view.capability, steer)}${view.needsYou ? ".needs" : ""}`;
        return item;
      }
      case "others": {
        const item = new vscode.TreeItem(node.line, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        item.command = { command: "mend.pickSession", title: "Choose a session" };
        item.contextValue = "mend.others";
        return item;
      }
      case "message": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = nodeId(node);
        if (node.detail !== undefined) item.description = node.detail;
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
    const node = this.current(element);
    if (node.kind !== "session" || !node.view.live) return item;
    const reads = workspaceReads(node.session);
    const [waitLine, retirement] = await Promise.all([
      reads.waiting ? this.client.waitLine(node.session.id) : null,
      reads.retirement ? this.client.workspaceRetirement(node.session.id) : null,
    ]);
    const members =
      retirement === null || retirement.launcher === null ? [] : await this.client.memberNames();
    item.tooltip = this.#tooltip(
      node.view,
      sessionLines({
        session: node.session,
        viewer: this.store.viewer(),
        waitLine,
        retirement,
        members,
      }),
    );
    return item;
  }

  getChildren(element?: MendNode): Array<MendNode> {
    const children = this.#layout?.get(element === undefined ? ROOT : nodeId(element)) ?? [];
    return children.map(({ id, node }) => {
      const given = this.#given.get(id);
      if (given !== undefined) return given;
      this.#given.set(id, node);
      return node;
    });
  }
}

export const isSessionNode = (
  value: unknown,
): value is { readonly kind: "session"; readonly project: Project; readonly session: Session } =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "session" &&
  typeof Reflect.get(value, "session") === "object";

export const isProjectNode = (
  value: unknown,
): value is { readonly kind: "project"; readonly project: Project } =>
  typeof value === "object" && value !== null && Reflect.get(value, "kind") === "project";

/** The session a row stands for, by id, for the view's selection. */
export const sessionIdOf = (node: MendNode): string | null =>
  node.kind === "session" ? node.session.id : null;
