import { Schema } from "effect";

import { SavedLayoutId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A person's saved layouts of a workspace's tiles (ADR 0026, "Layouts"). A layout is the
 * arrangement of tiles and the kinds of tab open in them, never a particular session: a saved
 * layout belongs to the person and shows in every workspace, so a conversation is only a place
 * that the workspace's conversations fill when the person applies it. The web app's built-in
 * layouts (Conversation only, Conversation beside change…) have the same shape.
 *
 * What is stored is a validated value with a `version`. A later change to tiles adds a version
 * beside this one and reads the older ones through it; anything this schema doesn't know is
 * refused, never stored. Writers decode with `onExcessProperty: "error"` (the API's payloads do),
 * so a key it doesn't know, such as a session's id, is refused rather than silently dropped.
 */

export const SAVED_LAYOUT_LIMITS = {
  /** Saved layouts per person. */
  layouts: 20,
  /** A name's length, in characters (code points). */
  nameCharacters: 48,
  tiles: 8,
  tabsPerTile: 16,
  childrenPerSplit: 8,
  /** Splits inside splits: a split holding only tiles is depth 1. */
  depth: 4,
} as const;

/** A view's id as the web app registers it: `change`, `terminal`, `preview`… */
const VIEW_ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * A tab of a layout: a place for one of the workspace's conversations, or a workspace view by its
 * id. The server keeps no list of views; an app skips a view it doesn't know when it applies one.
 */
export const LayoutTab = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session") }),
  Schema.Struct({
    kind: Schema.Literal("view"),
    view: Schema.String.check(Schema.isPattern(VIEW_ID)),
  }),
]);
export type LayoutTab = typeof LayoutTab.Type;

/** A tile: its tabs in strip order, and the place of the one that shows. */
export interface LayoutTile {
  readonly kind: "tile";
  readonly tabs: ReadonlyArray<LayoutTab>;
  readonly active: number;
}

/** Children side by side (`row`) or one over the other (`column`), each child's share in percent. */
export interface LayoutSplit {
  readonly kind: "split";
  readonly direction: "row" | "column";
  readonly children: ReadonlyArray<LayoutNode>;
  readonly sizes: ReadonlyArray<number>;
}

export type LayoutNode = LayoutTile | LayoutSplit;

const LayoutNodeRef = Schema.suspend((): Schema.Codec<LayoutNode> => LayoutNode);

const LayoutTileSchema = Schema.Struct({
  kind: Schema.Literal("tile"),
  tabs: Schema.Array(LayoutTab).check(Schema.isBetweenLength(1, SAVED_LAYOUT_LIMITS.tabsPerTile)),
  active: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const LayoutSplitSchema = Schema.Struct({
  kind: Schema.Literal("split"),
  direction: Schema.Literals(["row", "column"]),
  children: Schema.Array(LayoutNodeRef).check(
    Schema.isBetweenLength(2, SAVED_LAYOUT_LIMITS.childrenPerSplit),
  ),
  sizes: Schema.Array(Schema.Finite.check(Schema.isGreaterThan(0))),
});

export const LayoutNode: Schema.Codec<LayoutNode> = Schema.Union([
  LayoutTileSchema,
  LayoutSplitSchema,
]);

const tilesIn = (node: LayoutNode): ReadonlyArray<LayoutTile> =>
  node.kind === "tile" ? [node] : node.children.flatMap(tilesIn);

const depthOf = (node: LayoutNode): number =>
  node.kind === "tile" ? 0 : 1 + Math.max(...node.children.map(depthOf));

const nodeIssue = (node: LayoutNode): string | null => {
  if (node.kind === "tile") {
    return node.active < node.tabs.length ? null : "a tile's showing tab is one of its tabs";
  }
  if (node.sizes.length !== node.children.length) return "a split has one size for each child";
  for (const child of node.children) {
    const issue = nodeIssue(child);
    if (issue !== null) return issue;
  }
  return null;
};

/** The first thing wrong with a layout the shapes alone can't catch, or null. */
export const layoutIssue = (layout: {
  readonly root: LayoutNode;
  readonly focus: number;
}): string | null => {
  const tiles = tilesIn(layout.root).length;
  if (tiles > SAVED_LAYOUT_LIMITS.tiles) {
    return `a layout has at most ${SAVED_LAYOUT_LIMITS.tiles} tiles`;
  }
  if (depthOf(layout.root) > SAVED_LAYOUT_LIMITS.depth) {
    return `a layout's splits go at most ${SAVED_LAYOUT_LIMITS.depth} deep`;
  }
  if (layout.focus >= tiles) return "a layout's focused tile is one of its tiles";
  return nodeIssue(layout.root);
};

/**
 * A layout, version 1: the tree of tiles and the focused tile's place in reading order (left to
 * right, top to bottom).
 */
export const TileLayout = Schema.Struct({
  version: Schema.Literal(1),
  root: LayoutNode,
  focus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(Schema.makeFilter((layout) => layoutIssue(layout) ?? undefined));
export type TileLayout = typeof TileLayout.Type;

/** C0 and C1 control characters, DEL included: a line break or a tab has no place in a menu row. */
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

/**
 * The first thing wrong with a layout's name, or null. A name is trimmed, 1 to 48 characters, with
 * no control characters. That no two of a person's layouts share a name, ignoring case, is the
 * store's to check.
 */
export const savedLayoutNameIssue = (name: string): string | null => {
  if (name.trim() !== name) return "a layout's name has no spaces at either end";
  const characters = [...name];
  if (characters.length === 0) return "a layout needs a name";
  if (characters.length > SAVED_LAYOUT_LIMITS.nameCharacters) {
    return `a layout's name is at most ${SAVED_LAYOUT_LIMITS.nameCharacters} characters`;
  }
  if (characters.some(isControl)) return "a layout's name has no control characters";
  return null;
};

export const SavedLayoutName = Schema.String.check(
  Schema.makeFilter((name: string) => savedLayoutNameIssue(name) ?? undefined),
);

/** One of a person's saved layouts. */
export class SavedLayout extends Schema.Class<SavedLayout>("SavedLayout")({
  id: SavedLayoutId,
  name: SavedLayoutName,
  layout: TileLayout,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** The person's saved layouts, oldest first: the order of "Your layouts" and their shortcuts. */
export class SavedLayoutsView extends Schema.Class<SavedLayoutsView>("SavedLayoutsView")({
  layouts: Schema.Array(SavedLayout),
}) {}

/** Save this layout: the arrangement under a name. */
export class SaveLayoutRequest extends Schema.Class<SaveLayoutRequest>("SaveLayoutRequest")({
  name: SavedLayoutName,
  layout: TileLayout,
}) {}

/** Rename a saved layout: only its name changes. */
export class RenameLayoutRequest extends Schema.Class<RenameLayoutRequest>("RenameLayoutRequest")({
  name: SavedLayoutName,
}) {}

export class SavedLayoutRemoved extends Schema.Class<SavedLayoutRemoved>("SavedLayoutRemoved")({
  removed: Schema.Boolean,
}) {}
