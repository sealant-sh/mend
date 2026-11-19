/**
 * Layouts of a workspace's tiles (ADR 0026, "Layouts"): the four built in, and the person's saved
 * ones (`layouts.list`, the same in every workspace). A layout names kinds of tab, never a
 * particular session: a conversation is a place the workspace's open conversations fill. Applying
 * one changes only this workspace's arrangement, which the sheet then keeps as it keeps any other.
 *
 * The rule when a layout has fewer places than the sheet has tabs: nothing open is lost. Every tab
 * the layout didn't place joins the tile that holds the layout's first conversation (else its
 * first tile), after that tile's own tabs, not showing. T18 draws it: two conversations share one
 * tile under "Change over terminal".
 */
import {
  type LayoutNode,
  type LayoutTab,
  SAVED_LAYOUT_LIMITS,
  type TileLayout,
} from "@mend/domain/workbench";

import { OWN_SHORTCUTS } from "./search-keys";
import {
  type Arrangement,
  flatten,
  isNewSessionTab,
  sessionOfTab,
  type TileNode,
  tabsOf,
  tilesOf,
  viewOfTab,
  viewTab,
} from "./tiles";

export type BuiltInLayoutId =
  | "conversation"
  | "conversation-beside-change"
  | "change-over-terminal"
  | "two-sessions-over-terminal";

export interface BuiltInLayout {
  readonly id: BuiltInLayoutId;
  readonly name: string;
  readonly layout: TileLayout;
}

const conversation: LayoutTab = { kind: "session" };
const view = (id: string): LayoutTab => ({ kind: "view", view: id });
const tile = (tabs: ReadonlyArray<LayoutTab>): LayoutNode => ({ kind: "tile", tabs, active: 0 });
const split = (
  direction: "row" | "column",
  children: ReadonlyArray<LayoutNode>,
  sizes: ReadonlyArray<number>,
): LayoutNode => ({ kind: "split", direction, children, sizes });

/** The layout menu's four, in its order; ⌥1 to ⌥4 pick them. */
export const BUILT_IN_LAYOUTS: ReadonlyArray<BuiltInLayout> = [
  {
    id: "conversation",
    name: "Conversation only",
    layout: { version: 1, root: tile([conversation]), focus: 0 },
  },
  {
    id: "conversation-beside-change",
    name: "Conversation beside change",
    layout: {
      version: 1,
      root: split("row", [tile([conversation]), tile([view("change")])], [50, 50]),
      focus: 0,
    },
  },
  {
    // As T18 draws it: the conversation on the left, Change over Terminal on the right.
    id: "change-over-terminal",
    name: "Change over terminal",
    layout: {
      version: 1,
      root: split(
        "row",
        [
          tile([conversation]),
          split("column", [tile([view("change")]), tile([view("terminal")])], [60, 40]),
        ],
        [50, 50],
      ),
      focus: 0,
    },
  },
  {
    id: "two-sessions-over-terminal",
    name: "Two sessions over a terminal",
    layout: {
      version: 1,
      root: split(
        "column",
        [
          split("row", [tile([conversation]), tile([conversation])], [50, 50]),
          tile([view("terminal")]),
        ],
        [65, 35],
      ),
      focus: 0,
    },
  },
];

/** The most saved layouts the menu gives a shortcut: ⌥5 to ⌥9, after the four built in. */
export const SAVED_SHORTCUTS = 5;

/**
 * The layout the sheet shows now, to save: each conversation as a conversation's place, each view
 * by its id, the sizes as they are. A New session tab not yet sent isn't saved; a tile holding only
 * those leaves. Null when nothing is left to save.
 */
export const layoutOfArrangement = (arrangement: Arrangement): TileLayout | null => {
  const tiles: Array<string> = [];
  const nodeOf = (node: TileNode): LayoutNode | null => {
    if (node.kind === "tile") {
      const kept = node.tabs.filter((tab) => !isNewSessionTab(tab));
      if (kept.length === 0) return null;
      tiles.push(node.id);
      return {
        kind: "tile",
        tabs: kept.map((tab) => {
          const id = viewOfTab(tab);
          return id === null ? conversation : view(id);
        }),
        active: Math.max(0, kept.indexOf(node.active)),
      };
    }
    const children: Array<LayoutNode> = [];
    const sizes: Array<number> = [];
    node.children.forEach((child, index) => {
      const next = nodeOf(child);
      if (next === null) return;
      children.push(next);
      sizes.push(node.sizes[index] ?? 0);
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0] ?? null;
    return { kind: "split", direction: node.direction, children, sizes: shares(sizes) };
  };
  const root = nodeOf(arrangement.root);
  if (root === null) return null;
  return { version: 1, root, focus: Math.max(0, tiles.indexOf(arrangement.focus)) };
};

/** Sizes as shares of 100, in the same proportions. */
const shares = (sizes: ReadonlyArray<number>): ReadonlyArray<number> => {
  const total = sizes.reduce((sum, each) => sum + each, 0);
  return total <= 0
    ? sizes.map(() => 100 / sizes.length)
    : sizes.map((each) => (each / total) * 100);
};

export interface ApplyContext {
  /** The tab of the session whose page this is: the first conversation place takes it. */
  readonly own: string;
  /** Whether this app has the view: a layout naming one it doesn't skips it. */
  readonly knownView: (viewId: string) => boolean;
}

/** The sheet with `layout` applied (the module's comment says how). */
export const applyLayout = (
  arrangement: Arrangement,
  layout: TileLayout,
  context: ApplyContext,
): Arrangement => {
  const open = tabsOf(arrangement);
  const conversations = open.filter((tab) => sessionOfTab(tab) !== null);
  const queue = conversations.includes(context.own)
    ? [context.own, ...conversations.filter((tab) => tab !== context.own)]
    : conversations;
  const placed = new Set<string>();
  let tileCount = 0;
  let splitCount = 0;
  /** The new tile each of the layout's tiles became, in reading order; null when it left. */
  const became: Array<string | null> = [];
  let firstConversationTile: string | null = null;

  const build = (node: LayoutNode): TileNode | null => {
    if (node.kind === "tile") {
      const tabs: Array<string> = [];
      let active: string | null = null;
      let holdsConversation = false;
      node.tabs.forEach((slot, index) => {
        let tab: string | null = null;
        if (slot.kind === "session") {
          tab = queue.find((each) => !placed.has(each)) ?? null;
          if (tab !== null) holdsConversation = true;
        } else if (context.knownView(slot.view) && !placed.has(viewTab(slot.view))) {
          tab = viewTab(slot.view);
        }
        if (tab === null) return;
        placed.add(tab);
        tabs.push(tab);
        if (index === node.active) active = tab;
      });
      if (tabs.length === 0) {
        became.push(null);
        return null;
      }
      tileCount += 1;
      const id = `t${tileCount}`;
      became.push(id);
      if (holdsConversation && firstConversationTile === null) firstConversationTile = id;
      return { kind: "tile", id, tabs, active: active ?? tabs[0] ?? "" };
    }
    const children: Array<TileNode> = [];
    const sizes: Array<number> = [];
    node.children.forEach((child, index) => {
      const next = build(child);
      if (next === null) return;
      children.push(next);
      sizes.push(node.sizes[index] ?? 0);
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0] ?? null;
    splitCount += 1;
    return {
      kind: "split",
      id: `s${splitCount}`,
      direction: node.direction,
      children,
      sizes: shares(sizes),
    };
  };

  const built = build(layout.root);
  const leftover = open.filter((tab) => !placed.has(tab));
  if (built === null) {
    // Nothing the layout names is here (only views this app lacks): one tile of what is open.
    const tabs = open.length > 0 ? open : [context.own];
    return {
      root: {
        kind: "tile",
        id: "t1",
        tabs,
        active: tabs.includes(context.own) ? context.own : (tabs[0] ?? ""),
      },
      focus: "t1",
      maximised: null,
      closed: arrangement.closed,
    };
  }
  const home = firstConversationTile ?? tilesOf(built)[0]?.id;
  const withLeftover = (node: TileNode): TileNode =>
    node.kind === "tile"
      ? node.id === home
        ? { ...node, tabs: [...node.tabs, ...leftover] }
        : node
      : { ...node, children: node.children.map(withLeftover) };
  const root = flatten(leftover.length === 0 ? built : withLeftover(built));
  const focus = became[layout.focus] ?? tilesOf(root)[0]?.id ?? "t1";
  return { root, focus, maximised: null, closed: arrangement.closed };
};

/** A node's shape for comparing: the tree, and each tile's tabs as a set. Sizes don't count. */
const shapeOf = (node: TileNode): unknown =>
  node.kind === "tile"
    ? [...node.tabs].toSorted()
    : { direction: node.direction, children: node.children.map(shapeOf) };

/**
 * Whether the sheet is `layout` now: applying it would move no tab and add no tile (sizes, focus
 * and the showing tabs aside). The layout menu marks that layout with a check.
 */
export const showsLayout = (
  arrangement: Arrangement,
  layout: TileLayout,
  context: ApplyContext,
): boolean =>
  JSON.stringify(shapeOf(applyLayout(arrangement, layout, context).root)) ===
  JSON.stringify(shapeOf(arrangement.root));

/** Every tab in one tile, the focused tab showing: the menu's "Reset to one tile". */
export const oneTileOf = (arrangement: Arrangement): Arrangement => {
  const tabs = tabsOf(arrangement);
  const focused = tilesOf(arrangement.root).find((each) => each.id === arrangement.focus);
  const active = focused?.active ?? tabs[0] ?? "";
  return {
    root: { kind: "tile", id: "t1", tabs, active },
    focus: "t1",
    maximised: null,
    closed: arrangement.closed,
  };
};

/** The picture a layout's menu row shows, from its shape. */
export type LayoutPicture = "one" | "columns" | "rows" | "panel-left" | "panel-top" | "grid";

export const pictureOf = (layout: TileLayout): LayoutPicture => {
  const { root } = layout;
  if (root.kind === "tile") return "one";
  const leaves = root.children.every((child) => child.kind === "tile");
  if (leaves) return root.direction === "row" ? "columns" : "rows";
  if (root.children.length === 2) {
    const [first, second] = root.children;
    if (root.direction === "row" && first?.kind === "tile") return "panel-left";
    if (root.direction === "column" && second?.kind === "tile") return "panel-top";
  }
  return "grid";
};

/** The parts of a key press a layout's shortcut reads. */
export type LayoutKeyPress = Pick<
  KeyboardEvent,
  "code" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey" | "defaultPrevented" | "target"
>;

/**
 * The layout a key press picks: ⌥1 to ⌥9 (Alt on Windows and Linux), by the key's place, so a Mac's
 * ⌥1 typing "¡" still counts. Null for any other press, one already handled, or one made in an
 * element that keeps its keys (`data-own-shortcuts`, the terminal).
 */
export const layoutDigit = (press: LayoutKeyPress): number | null => {
  if (press.defaultPrevented || !press.altKey || press.metaKey || press.ctrlKey || press.shiftKey)
    return null;
  const match = /^Digit([1-9])$/.exec(press.code);
  if (match === null) return null;
  const target = press.target;
  if (target instanceof Element && target.closest(`[${OWN_SHORTCUTS}]`) !== null) return null;
  return Number(match[1]);
};

/** What is wrong with a layout's name, as the save dialog says it, or null. */
export const layoutNameIssue = (name: string): string | null => {
  const characters = [...name.trim()];
  if (characters.length === 0) return "Give the layout a name.";
  if (characters.length > SAVED_LAYOUT_LIMITS.nameCharacters)
    return `Keep the name to ${SAVED_LAYOUT_LIMITS.nameCharacters} characters.`;
  if (
    characters.some((each) => {
      const code = each.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    })
  )
    return "Keep the name to one line of plain text.";
  return null;
};
