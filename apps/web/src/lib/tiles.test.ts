import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  addToTile,
  type Arrangement,
  closeTab,
  forgetEnded,
  keepArrangement,
  KEPT_CHARACTERS,
  maximise,
  moveTab,
  openedWith,
  oneTile,
  parseArrangement,
  parseKeptArrangements,
  replaceTab,
  resizeSplit,
  type Side,
  splitTile,
  tabsOf,
  type TileNode,
  tileOfTab,
  tilesOf,
  withWorkspace,
} from "./tiles.ts";

const A = "session:a";
const B = "session:b";
const C = "session:c";
const CHANGE = "view:change";

/** The tree drawn small: a tile as its tabs joined by "|", a split as row(…) or column(…). */
const shape = (node: TileNode): string =>
  node.kind === "tile"
    ? node.tabs.join("|")
    : `${node.direction}(${node.children.map(shape).join(", ")})`;

const nobodyRuns = () => false;

describe("splitting and moving tabs", () => {
  it("splits a tile on each side, the new tile focused with half the space", () => {
    const start = oneTile([A, B], A);
    const cases: ReadonlyArray<readonly [Side, string]> = [
      ["right", "row(session:a, session:b)"],
      ["left", "row(session:b, session:a)"],
      ["bottom", "column(session:a, session:b)"],
      ["top", "column(session:b, session:a)"],
    ];
    for (const [side, drawn] of cases) {
      const split = splitTile(start, "t1", B, side);
      expect(shape(split.root)).toBe(drawn);
      expect(split.focus).toBe(tileOfTab(split, B)?.id);
      expect(split.root.kind === "split" ? split.root.sizes : null).toEqual([50, 50]);
    }
  });

  it("leaves a tile alone when its only tab is dropped on its own edge", () => {
    const split = splitTile(oneTile([A, B], A), "t1", B, "right");
    const right = tileOfTab(split, B)?.id ?? "";
    expect(splitTile(split, right, B, "bottom")).toBe(split);
  });

  it("splits beside a tile inside a split of the same direction without nesting", () => {
    const two = splitTile(oneTile([A, B, C], A), "t1", B, "right");
    const three = splitTile(two, "t1", C, "right");
    expect(shape(three.root)).toBe("row(session:a, session:c, session:b)");
    expect(three.root.kind === "split" ? three.root.sizes : null).toEqual([25, 25, 50]);
  });

  it("closes the tile a moved tab leaves empty, giving its space to the neighbour", () => {
    const split = resizeSplit(splitTile(oneTile([A, B], A), "t1", B, "right"), "s2", [70, 30]);
    const merged = addToTile(split, "t1", B);
    expect(shape(merged.root)).toBe("session:a|session:b");
    expect(merged.focus).toBe("t1");
    expect(tilesOf(merged.root)[0]?.active).toBe(B);
  });

  it("moves a tab by keyboard into the tile beside it, or splits when none is there", () => {
    const start = oneTile([A, B], A);
    const right = moveTab(start, B, "right");
    expect(shape(right.root)).toBe("row(session:a, session:b)");
    // Back left: into the tile that is there, which closes the one it leaves.
    expect(shape(moveTab(right, B, "left").root)).toBe("session:a|session:b");
    // The only tab of a tile with nothing beside it stays.
    expect(moveTab(right, B, "right")).toBe(right);
    // Down from the right tile: a new tile under it.
    const under = moveTab(addToTile(right, tileOfTab(right, B)?.id ?? "", C), C, "bottom");
    expect(shape(under.root)).toBe("row(session:a, column(session:b, session:c))");
    // Left from the bottom right tile reaches the left one.
    expect(shape(moveTab(under, C, "left").root)).toBe("row(session:a|session:c, session:b)");
  });
});

describe("closing tabs", () => {
  it("shows the next tab, and closes a tile with its last tab", () => {
    const tile = oneTile([A, B, C], B);
    expect(tilesOf(closeTab(tile, B, nobodyRuns).root)[0]?.active).toBe(C);
    expect(tilesOf(closeTab(tile, C, nobodyRuns).root)[0]?.active).toBe(B);

    const split = splitTile(oneTile([A, CHANGE], A), "t1", CHANGE, "right");
    const closed = closeTab(split, CHANGE, nobodyRuns);
    expect(shape(closed.root)).toBe("session:a");
    expect(closed.focus).toBe("t1");
  });

  it("never closes the sheet's last tab", () => {
    const tile = oneTile([A], A);
    expect(closeTab(tile, A, nobodyRuns)).toBe(tile);
  });

  it("keeps a running session closed, and only that", () => {
    const tile = oneTile([A, B, C], A);
    const closed = closeTab(
      closeTab(tile, B, (id) => id === "b"),
      C,
      (id) => id === "b",
    );
    expect(closed.closed).toEqual(["b"]);
    const sessions = [
      { id: "a", running: true },
      { id: "b", running: true },
      { id: "c", running: false },
    ];
    expect(tabsOf(withWorkspace(closed, sessions))).toEqual([A]);
  });
});

describe("sessions of the workspace", () => {
  it("opens a session that starts beside the active session tab of the focused tile", () => {
    const split = splitTile(oneTile([A, B, CHANGE], B), "t1", CHANGE, "right");
    const focusedLeft = { ...split, focus: "t1" };
    const shown = withWorkspace(focusedLeft, [
      { id: "a", running: true },
      { id: "b", running: true },
      { id: "c", running: true },
    ]);
    expect(shape(shown.root)).toBe("row(session:a|session:b|session:c, view:change)");
    // It opens without taking the place of what the person is looking at.
    expect(tileOfTab(shown, C)?.active).toBe(B);
  });

  it("opens the session the address names, focused, even when it was closed", () => {
    const split = splitTile(oneTile([A, B], A), "t1", B, "right");
    expect(openedWith(split, A).focus).toBe("t1");
    const closedC = { ...split, closed: ["c"] };
    const opened = openedWith(closedC, C);
    expect(opened.closed).toEqual([]);
    expect(tileOfTab(opened, C)?.active).toBe(C);
    expect(opened.focus).toBe(tileOfTab(opened, C)?.id);
    expect(openedWith(null, A)).toEqual(oneTile([A], A));
  });

  it("puts the layout back when the address names a tab the maximised tile doesn't hold", () => {
    const split = splitTile(oneTile([A, B], A), "t1", B, "right");
    const left = maximise(split, "t1");
    expect(openedWith(left, A).maximised).toBe("t1");
    expect(openedWith(left, B).maximised).toBeNull();
  });

  it("turns a New session tab into its session's tab in place", () => {
    const tile = oneTile([A, "new:1", B], "new:1");
    const started = replaceTab(tile, "new:1", C);
    expect(tabsOf(started)).toEqual([A, C, B]);
    expect(tilesOf(started.root)[0]?.active).toBe(C);
  });

  it("forgets closed sessions once they end", () => {
    const closed = { ...oneTile([A], A), closed: ["b", "c"] };
    expect(forgetEnded(closed, [{ id: "b", running: true }]).closed).toEqual(["b"]);
    expect(forgetEnded(closed, null)).toBe(closed);
  });
});

describe("what a browser keeps", () => {
  it("reads back what it wrote, and nothing broken", () => {
    const split = maximise(splitTile(oneTile([A, B], A), "t1", B, "bottom"), "t1");
    expect(parseArrangement(JSON.parse(JSON.stringify(split)))).toEqual(split);
    const twice = { ...split, root: { kind: "tile", id: "t1", tabs: [A, A], active: A } };
    expect(parseArrangement(twice)).toBeNull();
    expect(parseArrangement({ ...split, focus: "t9" })).toBeNull();
    expect(
      parseArrangement({ ...oneTile([A], A), root: { kind: "tile", id: "t1", tabs: [] } }),
    ).toBeNull();
    expect(parseKeptArrangements([["w1", split], ["w2", { root: 1 }], "x"])).toEqual([
      ["w1", split],
    ]);
  });

  it("keeps the workspaces used last, within what a cookie can carry", () => {
    const big = oneTile(
      Array.from({ length: 12 }, (_, at) => `session:${String(at).padStart(30, "0")}`),
      `session:${"0".repeat(30)}`,
    );
    let kept = keepArrangement([], "w0", big);
    for (let at = 1; at < 30; at += 1) kept = keepArrangement(kept, `w${at}`, big);
    expect(kept[0]?.[0]).toBe("w29");
    expect(kept.length).toBeGreaterThan(1);
    expect(encodeURIComponent(JSON.stringify(kept)).length).toBeLessThanOrEqual(KEPT_CHARACTERS);
    // Using a workspace again brings it to the front, once.
    const again = keepArrangement(kept, "w28", big);
    expect(again.map(([id]) => id).filter((id) => id === "w28")).toHaveLength(1);
    expect(again[0]?.[0]).toBe("w28");
  });
});

/** Every split's children: at least two, none a split running the split's own way. */
const wellFormed = (node: TileNode): boolean =>
  node.kind === "tile"
    ? node.tabs.length > 0 && node.tabs.includes(node.active)
    : node.children.length >= 2 &&
      node.sizes.length === node.children.length &&
      node.children.every(
        (child) =>
          wellFormed(child) && (child.kind === "tile" || child.direction !== node.direction),
      );

/** Each split's shares add up to 100. */
const total = (node: TileNode): boolean =>
  node.kind === "tile" ||
  (Math.abs(node.sizes.reduce((sum, size) => sum + size, 0) - 100) < 1e-6 &&
    node.children.every(total));

describe("any sequence of moves", () => {
  const TABS = [A, B, C, CHANGE, "view:terminal"] as const;
  const SIDES: ReadonlyArray<Side> = ["left", "right", "top", "bottom"];
  const step = fc.oneof(
    fc.record({
      kind: fc.constant("split" as const),
      tile: fc.nat(5),
      tab: fc.constantFrom(...TABS),
      side: fc.constantFrom(...SIDES),
    }),
    fc.record({
      kind: fc.constant("add" as const),
      tile: fc.nat(5),
      tab: fc.constantFrom(...TABS),
      index: fc.nat(5),
    }),
    fc.record({
      kind: fc.constant("move" as const),
      tab: fc.constantFrom(...TABS),
      side: fc.constantFrom(...SIDES),
    }),
    fc.record({ kind: fc.constant("close" as const), tab: fc.constantFrom(...TABS) }),
  );

  type Step = typeof step extends fc.Arbitrary<infer Value> ? Value : never;

  const apply = (arrangement: Arrangement, move: Step): Arrangement => {
    const tiles = tilesOf(arrangement.root);
    const tileId = "tile" in move ? (tiles[move.tile % tiles.length]?.id ?? "") : "";
    switch (move.kind) {
      case "split":
        return splitTile(arrangement, tileId, move.tab, move.side);
      case "add":
        return addToTile(arrangement, tileId, move.tab, move.index);
      case "move":
        return moveTab(arrangement, move.tab, move.side);
      case "close":
        return closeTab(arrangement, move.tab, nobodyRuns);
    }
  };

  it("keeps every tab in one tile, no tile empty, and reads back as kept", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (moves) => {
        const start = oneTile([A, B, C], A);
        const end = moves.reduce(apply, start);
        const tabs = tabsOf(end);
        expect(new Set(tabs).size).toBe(tabs.length);
        expect(wellFormed(end.root)).toBe(true);
        expect(tilesOf(end.root).some((tile) => tile.id === end.focus)).toBe(true);
        // The sheet never empties; a tab only leaves by being closed.
        expect(tabs.length).toBeGreaterThan(0);
        expect(parseArrangement(JSON.parse(JSON.stringify(end)))).toEqual(end);
        // Space neither appears nor goes: each split's shares still add up to its start.
        expect(total(end.root)).toBe(true);
      }),
      { seed: 1137, numRuns: 400 },
    );
  });
});
