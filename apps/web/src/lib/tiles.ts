/**
 * How a workspace's sheet is split into tiles (ADR 0026): a tree whose leaves are tiles, each with
 * its tabs and its active tab, and whose inner nodes split their children into a row (side by
 * side) or a column (one over the other), each child with its share of the space. Every change a
 * person makes to the arrangement is a function here; the sheet only draws the result.
 *
 * A tab is a key: `session:<id>` for a session's conversation, `view:<id>` for a workspace view
 * (Change, Terminal…), `new:<n>` for a New session tab not yet sent. A key is in at most one tile.
 */

/** A tile: its tabs in strip order, and the one whose body shows. */
export interface TileLeaf {
  readonly kind: "tile";
  readonly id: string;
  readonly tabs: ReadonlyArray<string>;
  readonly active: string;
}

/** Children side by side (`row`) or one over the other (`column`), with their shares in percent. */
export interface TileSplit {
  readonly kind: "split";
  readonly id: string;
  readonly direction: "row" | "column";
  readonly children: ReadonlyArray<TileNode>;
  readonly sizes: ReadonlyArray<number>;
}

export type TileNode = TileLeaf | TileSplit;

export interface Arrangement {
  readonly root: TileNode;
  /** The focused tile: its active tab has the cobalt underline, and "+" and new sessions go there. */
  readonly focus: string;
  /** The tile filling the sheet, if one is maximised. */
  readonly maximised: string | null;
  /**
   * Sessions still running that the person closed the tab of: they stay closed, where a session
   * that starts in the workspace opens as a tab by itself.
   */
  readonly closed: ReadonlyArray<string>;
}

/** Where a moved tab lands beside a tile: an edge splits it. */
export type Side = "left" | "right" | "top" | "bottom";

export const sessionTab = (sessionId: string): string => `session:${sessionId}`;
export const viewTab = (viewId: string): string => `view:${viewId}`;

/** The session a tab shows, or null for a view or a New session tab. */
export const sessionOfTab = (tab: string): string | null =>
  tab.startsWith("session:") ? tab.slice("session:".length) : null;

/** The view a tab shows, or null. */
export const viewOfTab = (tab: string): string | null =>
  tab.startsWith("view:") ? tab.slice("view:".length) : null;

export const isNewSessionTab = (tab: string): boolean => tab.startsWith("new:");

/** One tile holding `tabs`, `active` showing. */
export const oneTile = (tabs: ReadonlyArray<string>, active: string): Arrangement => ({
  root: { kind: "tile", id: "t1", tabs, active },
  focus: "t1",
  maximised: null,
  closed: [],
});

/** Every tile, in reading order (left to right, top to bottom). */
export const tilesOf = (node: TileNode): ReadonlyArray<TileLeaf> =>
  node.kind === "tile" ? [node] : node.children.flatMap(tilesOf);

/** Every tab, in reading order: the order of the one strip under 1024px. */
export const tabsOf = (arrangement: Arrangement): ReadonlyArray<string> =>
  tilesOf(arrangement.root).flatMap((tile) => tile.tabs);

export const tileById = (arrangement: Arrangement, tileId: string): TileLeaf | undefined =>
  tilesOf(arrangement.root).find((tile) => tile.id === tileId);

export const tileOfTab = (arrangement: Arrangement, tab: string): TileLeaf | undefined =>
  tilesOf(arrangement.root).find((tile) => tile.tabs.includes(tab));

/** The focused tile's active tab: what the one strip under 1024px shows. */
export const focusedTab = (arrangement: Arrangement): string => {
  const focused = tileById(arrangement, arrangement.focus) ?? tilesOf(arrangement.root)[0];
  return focused?.active ?? "";
};

/** Whether a node is, or holds, the tile `tileId`: the path the sheet keeps on screen. */
export const holdsTile = (node: TileNode, tileId: string): boolean =>
  node.kind === "tile" ? node.id === tileId : node.children.some((c) => holdsTile(c, tileId));

/** Every number a node's id carries, its children's included. */
const idNumbers = (node: TileNode): ReadonlyArray<number> => [
  Number(node.id.slice(1)) || 0,
  ...(node.kind === "split" ? node.children.flatMap(idNumbers) : []),
];

/** A new id for a tile or a split: one past the highest number any node has. */
const nextId = (root: TileNode, prefix: "t" | "s"): string =>
  `${prefix}${Math.max(0, ...idNumbers(root)) + 1}`;

/** Replace each tile through `change`; a tile it answers null for leaves the tree. */
const mapTiles = (node: TileNode, change: (tile: TileLeaf) => TileNode | null): TileNode | null => {
  if (node.kind === "tile") return change(node);
  const children: Array<TileNode> = [];
  const sizes: Array<number> = [];
  // Space a child that left gives to the neighbour before it, or after it when it was first.
  let freed = 0;
  node.children.forEach((child, index) => {
    const size = node.sizes[index] ?? 0;
    const next = mapTiles(child, change);
    if (next === null) {
      if (sizes.length > 0) sizes[sizes.length - 1] = (sizes[sizes.length - 1] ?? 0) + size;
      else freed += size;
      return;
    }
    children.push(next);
    sizes.push(size + freed);
    freed = 0;
  });
  if (children.length === 0) return null;
  // A split left with one child is that child, in the split's place.
  if (children.length === 1) return children[0] ?? null;
  return { ...node, children, sizes };
};

/** A split whose child splits run its own way takes their children in, sizes scaled. */
const flatten = (node: TileNode): TileNode => {
  if (node.kind === "tile") return node;
  const children: Array<TileNode> = [];
  const sizes: Array<number> = [];
  node.children.forEach((child, index) => {
    const flat = flatten(child);
    const size = node.sizes[index] ?? 0;
    if (flat.kind === "split" && flat.direction === node.direction) {
      const total = flat.sizes.reduce((sum, each) => sum + each, 0) || 1;
      flat.children.forEach((inner, at) => {
        children.push(inner);
        sizes.push(((flat.sizes[at] ?? 0) / total) * size);
      });
      return;
    }
    children.push(flat);
    sizes.push(size);
  });
  return { ...node, children, sizes };
};

/** The tile that takes focus when the focused one leaves: the first tile still there. */
const withFocusKept = (arrangement: Arrangement, root: TileNode): Arrangement => {
  const tiles = tilesOf(root);
  const focus = tiles.some((tile) => tile.id === arrangement.focus)
    ? arrangement.focus
    : (tiles[0]?.id ?? arrangement.focus);
  const maximised =
    arrangement.maximised !== null && tiles.some((tile) => tile.id === arrangement.maximised)
      ? arrangement.maximised
      : null;
  return { ...arrangement, root, focus, maximised };
};

/** Takes `tab` out of its tile. The tile's next tab, else the one before, becomes active. */
const without = (root: TileNode, tab: string): TileNode | null =>
  mapTiles(root, (tile) => {
    const at = tile.tabs.indexOf(tab);
    if (at === -1) return tile;
    const tabs = tile.tabs.filter((each) => each !== tab);
    if (tabs.length === 0) return null;
    const active = tile.active === tab ? (tabs[at] ?? tabs[at - 1] ?? tabs[0] ?? "") : tile.active;
    return { ...tile, tabs, active };
  });

/** Shows `tab` in its tile and focuses that tile. */
export const activate = (arrangement: Arrangement, tab: string): Arrangement => {
  const home = tileOfTab(arrangement, tab);
  if (home === undefined) return arrangement;
  const root =
    mapTiles(arrangement.root, (tile) => (tile.id === home.id ? { ...tile, active: tab } : tile)) ??
    arrangement.root;
  return { ...arrangement, root, focus: home.id };
};

export const focusTile = (arrangement: Arrangement, tileId: string): Arrangement =>
  arrangement.focus === tileId || tileById(arrangement, tileId) === undefined
    ? arrangement
    : { ...arrangement, focus: tileId };

/**
 * Puts `tab` in tile `tileId` at `index` (the end when left out), showing and focused. A tab
 * already in another tile moves; the tile it leaves closes if that was its last tab.
 */
export const addToTile = (
  arrangement: Arrangement,
  tileId: string,
  tab: string,
  index?: number,
): Arrangement => {
  const target = tileById(arrangement, tileId);
  if (target === undefined) return arrangement;
  const placed = mapTiles(arrangement.root, (tile) => {
    const tabs = tile.tabs.filter((each) => each !== tab);
    if (tile.id === tileId) {
      const at = Math.min(index ?? tabs.length, tabs.length);
      return { ...tile, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)], active: tab };
    }
    if (tabs.length === tile.tabs.length) return tile;
    if (tabs.length === 0) return null;
    const left = tile.tabs.indexOf(tab);
    const active =
      tile.active === tab ? (tabs[left] ?? tabs[left - 1] ?? tabs[0] ?? "") : tile.active;
    return { ...tile, tabs, active };
  });
  if (placed === null) return arrangement;
  return {
    ...withFocusKept(arrangement, flatten(placed)),
    focus: tileId,
    closed: arrangement.closed.filter((id) => sessionTab(id) !== tab),
  };
};

/**
 * Splits tile `tileId` on `side`, with `tab` alone in the new tile, which takes half the tile's
 * space and the focus. A tab dragged off a tile it is the only tab of onto that tile's own edge
 * changes nothing.
 */
export const splitTile = (
  arrangement: Arrangement,
  tileId: string,
  tab: string,
  side: Side,
): Arrangement => {
  const target = tileById(arrangement, tileId);
  if (target === undefined) return arrangement;
  if (target.tabs.length === 1 && target.tabs[0] === tab) return arrangement;
  const freed = without(arrangement.root, tab);
  if (freed === null) return arrangement;
  const id = nextId(arrangement.root, "t");
  const fresh: TileLeaf = { kind: "tile", id, tabs: [tab], active: tab };
  const direction = side === "left" || side === "right" ? "row" : "column";
  const first = side === "left" || side === "top";
  const split = (node: TileNode): TileNode => {
    if (node.kind === "tile") {
      if (node.id !== tileId) return node;
      return {
        kind: "split",
        id: nextId(arrangement.root, "s"),
        direction,
        children: first ? [fresh, node] : [node, fresh],
        sizes: [50, 50],
      };
    }
    return { ...node, children: node.children.map(split) };
  };
  const root = flatten(split(freed));
  return {
    ...withFocusKept(arrangement, root),
    focus: id,
    closed: arrangement.closed.filter((each) => sessionTab(each) !== tab),
  };
};

/**
 * Closes `tab`. A tile left with no tab closes, and its neighbour takes its space. The last tab of
 * the sheet stays: a sheet always shows something. A running session closed by hand stays closed.
 */
export const closeTab = (
  arrangement: Arrangement,
  tab: string,
  running: (sessionId: string) => boolean,
): Arrangement => {
  if (tileOfTab(arrangement, tab) === undefined) return arrangement;
  const root = without(arrangement.root, tab);
  if (root === null) return arrangement;
  const session = sessionOfTab(tab);
  return {
    ...withFocusKept(arrangement, flatten(root)),
    closed:
      session !== null && running(session) && !arrangement.closed.includes(session)
        ? [...arrangement.closed, session]
        : arrangement.closed,
  };
};

/** Puts `to` where `from` is, as the same tile's tab: a New session tab becomes its session's. */
export const replaceTab = (arrangement: Arrangement, from: string, to: string): Arrangement => {
  if (tileOfTab(arrangement, from) === undefined) return arrangement;
  const cleared = to === from ? arrangement.root : without(arrangement.root, to);
  const root =
    mapTiles(cleared ?? arrangement.root, (tile) =>
      tile.tabs.includes(from)
        ? {
            ...tile,
            tabs: tile.tabs.map((each) => (each === from ? to : each)),
            active: tile.active === from ? to : tile.active,
          }
        : tile,
    ) ?? arrangement.root;
  return withFocusKept(arrangement, root);
};

/** New shares for a split's children, as the divider left them. */
export const resizeSplit = (
  arrangement: Arrangement,
  splitId: string,
  sizes: ReadonlyArray<number>,
): Arrangement => {
  const resize = (node: TileNode): TileNode =>
    node.kind === "tile"
      ? node
      : node.id === splitId && sizes.length === node.children.length
        ? { ...node, sizes }
        : { ...node, children: node.children.map(resize) };
  return { ...arrangement, root: resize(arrangement.root) };
};

/** Maximises tile `tileId` (and focuses it), or with null puts the layout back. */
export const maximise = (arrangement: Arrangement, tileId: string | null): Arrangement =>
  tileId === null
    ? { ...arrangement, maximised: null }
    : tileById(arrangement, tileId) === undefined
      ? arrangement
      : { ...arrangement, maximised: tileId, focus: tileId };

/** The tile next to `tileId` on `side`, if the layout has one there. */
const neighbourOf = (root: TileNode, tileId: string, side: Side): TileLeaf | undefined => {
  const direction = side === "left" || side === "right" ? "row" : "column";
  const step = side === "left" || side === "top" ? -1 : 1;
  const find = (node: TileNode): TileLeaf | "here" | undefined => {
    if (node.kind === "tile") return node.id === tileId ? "here" : undefined;
    for (const [index, child] of node.children.entries()) {
      const found = find(child);
      if (found === undefined) continue;
      if (found !== "here") return found;
      const beside = node.direction === direction ? node.children[index + step] : undefined;
      if (beside === undefined) return "here";
      const tiles = tilesOf(beside);
      return step === 1 ? tiles[0] : tiles[tiles.length - 1];
    }
    return undefined;
  };
  const found = find(root);
  return found === "here" ? undefined : found;
};

/**
 * The keyboard's move of `tab` toward `side`: into the tile beside its own on that side, or, when
 * there is none, into a new tile split off on that side. A tile's only tab with no tile beside it
 * stays.
 */
export const moveTab = (arrangement: Arrangement, tab: string, side: Side): Arrangement => {
  const home = tileOfTab(arrangement, tab);
  if (home === undefined) return arrangement;
  const beside = neighbourOf(arrangement.root, home.id, side);
  if (beside !== undefined) return addToTile(arrangement, beside.id, tab);
  return splitTile(arrangement, home.id, tab, side);
};

/**
 * Where a session that starts in the workspace opens: beside the active session tab of the focused
 * tile (after the focused tile's last session tab when a view shows there, else first).
 */
const besideActiveSession = (arrangement: Arrangement, tab: string): Arrangement => {
  const focused = tileById(arrangement, arrangement.focus) ?? tilesOf(arrangement.root)[0];
  if (focused === undefined) return arrangement;
  const sessions = focused.tabs.filter((each) => sessionOfTab(each) !== null);
  const after =
    sessionOfTab(focused.active) !== null ? focused.active : sessions[sessions.length - 1];
  const at = after === undefined ? 0 : focused.tabs.indexOf(after) + 1;
  const root =
    mapTiles(arrangement.root, (tile) =>
      tile.id === focused.id
        ? { ...tile, tabs: [...tile.tabs.slice(0, at), tab, ...tile.tabs.slice(at)] }
        : tile,
    ) ?? arrangement.root;
  return { ...arrangement, root };
};

/** A session of the workspace, as the arrangement needs to know it. */
export interface WorkspaceSession {
  readonly id: string;
  /** Not ended: running, waiting, idle between turns, starting. */
  readonly running: boolean;
}

/**
 * The arrangement as the workspace stands: every running session of the workspace has a tab
 * unless the person closed it, each new one opening beside the active session tab of the focused
 * tile. Sessions that ended stay where they are, or in the "+" menu.
 */
export const withWorkspace = (
  arrangement: Arrangement,
  sessions: ReadonlyArray<WorkspaceSession>,
): Arrangement => {
  const shown = new Set(tabsOf(arrangement));
  return sessions
    .filter(
      (session) =>
        session.running &&
        !arrangement.closed.includes(session.id) &&
        !shown.has(sessionTab(session.id)),
    )
    .reduceRight((next, session) => besideActiveSession(next, sessionTab(session.id)), arrangement);
};

/**
 * The arrangement a session's page starts with: the one kept for the workspace (or one tile of
 * the session's tab), with `opened` (the tab the address names) showing in its tile, or added
 * beside the active session tab of the focused tile, and focused.
 */
export const openedWith = (kept: Arrangement | null, opened: string): Arrangement => {
  if (kept === null) return oneTile([opened], opened);
  const session = sessionOfTab(opened);
  const reopened =
    session === null ? kept : { ...kept, closed: kept.closed.filter((id) => id !== session) };
  const placed =
    tileOfTab(reopened, opened) === undefined ? besideActiveSession(reopened, opened) : reopened;
  const shown = activate(placed, opened);
  // A tab the address names shows, even past a maximised tile that doesn't hold it.
  return shown.maximised !== null && shown.maximised !== shown.focus
    ? { ...shown, maximised: null }
    : shown;
};

/** Running sessions closed by hand that the workspace no longer runs needn't be remembered. */
export const forgetEnded = (
  arrangement: Arrangement,
  sessions: ReadonlyArray<WorkspaceSession> | null,
): Arrangement => {
  if (sessions === null) return arrangement;
  const running = new Set(sessions.filter((each) => each.running).map((each) => each.id));
  const closed = arrangement.closed.filter((id) => running.has(id));
  return closed.length === arrangement.closed.length ? arrangement : { ...arrangement, closed };
};

// What a browser keeps -----------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTabKey = (value: unknown): value is string =>
  typeof value === "string" && /^(session|view|new):[\w-]{1,80}$/.test(value);

const parseNode = (value: unknown, depth: number): TileNode | null => {
  if (!isRecord(value) || depth > 8 || typeof value["id"] !== "string") return null;
  const id = value["id"];
  if (value["kind"] === "tile") {
    const { tabs, active } = value;
    if (!Array.isArray(tabs) || tabs.length === 0 || !tabs.every(isTabKey)) return null;
    if (typeof active !== "string" || !tabs.includes(active)) return null;
    return { kind: "tile", id, tabs, active };
  }
  if (value["kind"] !== "split") return null;
  const { direction, children, sizes } = value;
  if (direction !== "row" && direction !== "column") return null;
  if (!Array.isArray(children) || children.length < 2 || !Array.isArray(sizes)) return null;
  if (sizes.length !== children.length) return null;
  if (!sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0))
    return null;
  const parsed = children.map((child) => parseNode(child, depth + 1));
  if (parsed.some((child) => child === null)) return null;
  return {
    kind: "split",
    id,
    direction,
    children: parsed.filter((child) => child !== null),
    sizes: sizes.filter((size) => typeof size === "number"),
  };
};

/**
 * An arrangement as a browser kept it, or null when it isn't one: a tab in two tiles, two nodes
 * with one id, focus on a tile that isn't there. A kept arrangement that doesn't read starts again
 * from one tile.
 */
export const parseArrangement = (value: unknown): Arrangement | null => {
  if (!isRecord(value)) return null;
  const root = parseNode(value["root"], 0);
  if (root === null) return null;
  const tiles = tilesOf(root);
  const tabs = tiles.flatMap((tile) => tile.tabs);
  if (new Set(tabs).size !== tabs.length) return null;
  const ids: Array<string> = [];
  const collect = (node: TileNode) => {
    ids.push(node.id);
    if (node.kind === "split") node.children.forEach(collect);
  };
  collect(root);
  if (new Set(ids).size !== ids.length) return null;
  const { focus, maximised, closed } = value;
  if (typeof focus !== "string" || !tiles.some((tile) => tile.id === focus)) return null;
  return {
    root,
    focus,
    maximised:
      typeof maximised === "string" && tiles.some((tile) => tile.id === maximised)
        ? maximised
        : null,
    closed: Array.isArray(closed)
      ? closed.filter((id): id is string => typeof id === "string")
      : [],
  };
};

/** Each workspace's arrangement in this browser, by worktree id, the last one used first. */
export type KeptArrangements = ReadonlyArray<readonly [string, Arrangement]>;

/** The arrangements a browser kept; anything that doesn't read is left out. */
export const parseKeptArrangements = (stored: unknown): KeptArrangements =>
  Array.isArray(stored)
    ? stored.flatMap((entry): KeptArrangements => {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") return [];
        const arrangement = parseArrangement(entry[1]);
        return arrangement === null ? [] : [[entry[0], arrangement]];
      })
    : [];

/**
 * A cookie goes with every request to the server, and servers refuse a request whose headers grow
 * past about 8 KB: the arrangements kept are the last few workspaces', within this many characters.
 */
export const KEPT_CHARACTERS = 2400;

/**
 * Keeps `arrangement` for `worktreeId` as the last one used, dropping the workspaces used longest
 * ago until what is kept fits in `KEPT_CHARACTERS`, once encoded for the cookie.
 */
export const keepArrangement = (
  kept: KeptArrangements,
  worktreeId: string,
  arrangement: Arrangement,
): KeptArrangements => {
  const next: Array<readonly [string, Arrangement]> = [
    [worktreeId, arrangement],
    ...kept.filter(([id]) => id !== worktreeId),
  ];
  while (next.length > 1 && encodeURIComponent(JSON.stringify(next)).length > KEPT_CHARACTERS)
    next.pop();
  return next;
};
