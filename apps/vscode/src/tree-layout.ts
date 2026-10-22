import {
  othersLine,
  type ProjectRows,
  type SessionView,
  type ViewGroup,
  type WindowModel,
} from "./session-model.js";
import type { Project, Session } from "./types.js";

/**
 * What the Mend view shows, as a tree of nodes with stable ids, and which of them a new model
 * redraws. Pure: `tree.ts` maps it onto VS Code.
 */

export type GroupKind = ViewGroup["kind"];

export type GroupNode = { readonly kind: "group"; readonly group: ViewGroup };
export type ProjectNode = { readonly kind: "project"; readonly project: Project };
export type ProjectRowsNode = {
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
export type RowNode = SessionNode & {
  readonly view: SessionView;
  readonly place: string;
};
export type OthersNode = { readonly kind: "others"; readonly line: string };
export type MessageNode = {
  readonly kind: "message";
  readonly label: string;
  readonly detail?: string;
};
export type MendNode =
  | GroupNode
  | ProjectNode
  | ProjectRowsNode
  | RowNode
  | OthersNode
  | MessageNode;

/** The tree's id of a node: the same row in the same place keeps it from one model to the next. */
export const nodeId = (node: MendNode): string => {
  switch (node.kind) {
    case "group":
      return `group:${node.group.kind}`;
    case "project":
      return `projects:project:${node.project.id}`;
    case "project-rows":
      return `${node.group}:project:${node.rows.project.id}`;
    case "session":
      return `${node.place}:${node.session.id}`;
    case "others":
      return "others";
    case "message":
      return `message:${node.label}`;
  }
};

export const ROOT = "";

/** A node, and what of it the tree draws: a change in anything else must not redraw it. */
export interface Placed {
  readonly id: string;
  readonly node: MendNode;
  readonly drawn: string;
}

/** Per parent id (`ROOT` for the top), its children in order. */
export type Layout = ReadonlyMap<string, ReadonlyArray<Placed>>;

export const rowsOfGroup = (group: ViewGroup): ReadonlyArray<SessionView> =>
  group.kind === "projects" ? group.projects.flatMap((one) => one.rows) : group.rows;

const row = (view: SessionView, place: string): RowNode => ({
  kind: "session",
  project: view.project,
  session: view.session,
  view,
  place,
});

const drawnRow = (view: SessionView, viewer: string | null): string =>
  JSON.stringify([
    view.name,
    view.line,
    view.provenance,
    view.word,
    view.needsYou,
    view.live,
    view.capability,
    view.session.ownerUserId,
    view.session.sharedControlEnabledAt,
    view.session.livePeople,
    view.session.workspaceRetirement,
    view.session.branch,
    viewer,
  ]);

const TOP_GROUPS: ReadonlyArray<GroupKind> = ["needs", "since", "running", "projects"];

/** A group with no rows; none for Projects, which shows once a project is adopted. */
const emptyGroup = (kind: GroupKind): ViewGroup | null => {
  switch (kind) {
    case "needs":
    case "running":
      return { kind, rows: [] };
    case "since":
      return { kind, rows: [], byProject: null };
    case "projects":
      return null;
  }
};

/** The tree the view shows for a model, as the store last read it. */
export const layoutOf = (input: {
  readonly model: WindowModel | null;
  readonly hasRead: boolean;
  /** The last read's failure in words; null when reads succeed. */
  readonly error: string | null;
  readonly viewer: string | null;
}): Layout => {
  const { model, hasRead, error, viewer } = input;
  const layout = new Map<string, Array<Placed>>();
  const place = (parent: string, node: MendNode, drawn: string): string => {
    const id = nodeId(node);
    layout.set(parent, [...(layout.get(parent) ?? []), { id, node, drawn }]);
    return id;
  };
  const placeRow = (parent: string, view: SessionView, where: string): void => {
    place(parent, row(view, where), drawnRow(view, viewer));
  };
  const placeMessage = (label: string): void => {
    const detail = "Run Mend: Connect to server";
    place(ROOT, { kind: "message", label, detail }, JSON.stringify([label, detail]));
  };
  layout.set(ROOT, []);
  if (error !== null) placeMessage(error);
  if (model === null || (!hasRead && !model.offline)) return layout;

  const placeGroup = (group: ViewGroup): void => {
    const id = place(
      ROOT,
      { kind: "group", group },
      JSON.stringify([
        group.kind,
        group.kind === "projects" ? group.projects.length : rowsOfGroup(group).length,
      ]),
    );
    layout.set(id, []);
    if (group.kind === "projects") {
      for (const one of group.projects) {
        const projectId = place(
          id,
          { kind: "project", project: one.project },
          JSON.stringify(one.project),
        );
        layout.set(projectId, []);
        for (const view of one.rows) placeRow(projectId, view, `projects:${one.project.id}`);
      }
      return;
    }
    if (group.kind === "since" && group.byProject !== null) {
      for (const rows of group.byProject) {
        const rowsId = place(
          id,
          { kind: "project-rows", group: group.kind, rows },
          JSON.stringify([rows.project, rows.rows.length]),
        );
        layout.set(rowsId, []);
        for (const view of rows.rows) placeRow(rowsId, view, `${group.kind}:${rows.project.id}`);
      }
      return;
    }
    for (const view of group.rows) placeRow(id, view, group.kind);
  };

  // The top level stays put as sessions come and go (an empty group reads `nothing`, as story f
  // has `Running: nothing`), so a change below it never redraws the whole tree.
  if (model.kind === "local") {
    for (const kind of TOP_GROUPS) {
      const group = model.groups.find((candidate) => candidate.kind === kind) ?? emptyGroup(kind);
      if (group !== null) placeGroup(group);
    }
    return layout;
  }
  if (model.session !== null) placeRow(ROOT, model.session, "own");
  const line = othersLine(model.others);
  place(ROOT, { kind: "others", line }, line);
  return layout;
};

const ids = (layout: Layout, parent: string): string =>
  (layout.get(parent) ?? []).map((placed) => placed.id).join("\n");

/**
 * What a new layout redraws: everything when the top level moved; otherwise each parent whose
 * children moved (it redraws them), and each other node whose drawing changed. VS Code forgets
 * every row a redraw covers until it reads them again, and runs a click on a forgotten row with no
 * row at all; redrawing only what moved keeps every other row, the clicked one included.
 */
export const redraws = (prev: Layout | null, next: Layout): "all" | ReadonlyArray<string> => {
  if (prev === null || ids(prev, ROOT) !== ids(next, ROOT)) return "all";
  const parentOf = new Map<string, string>();
  const drawnBefore = new Map<string, string>();
  for (const [parent, children] of next)
    for (const child of children) parentOf.set(child.id, parent);
  for (const children of prev.values())
    for (const child of children) drawnBefore.set(child.id, child.drawn);
  const moved = new Set(
    [...next.keys()].filter(
      (parent) => parent !== ROOT && prev.has(parent) && ids(prev, parent) !== ids(next, parent),
    ),
  );
  const covered = (id: string): boolean => {
    for (let parent = parentOf.get(id); parent !== undefined; parent = parentOf.get(parent))
      if (moved.has(parent)) return true;
    return false;
  };
  const changed = [...next.values()].flatMap((children) =>
    children.flatMap((child) =>
      drawnBefore.has(child.id) && drawnBefore.get(child.id) !== child.drawn && !covered(child.id)
        ? [child.id]
        : [],
    ),
  );
  return [
    ...[...moved].filter((parent) => !covered(parent)),
    ...changed.filter((id) => !moved.has(id)),
  ];
};
