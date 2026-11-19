import type { TileLayout } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  applyLayout,
  BUILT_IN_LAYOUTS,
  layoutOfArrangement,
  oneTileOf,
  showsLayout,
} from "./layouts";
import { type Arrangement, oneTile, splitTile, tabsOf, tilesOf } from "./tiles";

const own = "session:a";
const other = "session:b";
const third = "session:c";
const change = "view:change";
const terminal = "view:terminal";
const context = { own, knownView: (id: string) => id !== "screen" };
const builtIn = (id: string): TileLayout => {
  const found = BUILT_IN_LAYOUTS.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no built-in layout ${id}`);
  return found.layout;
};
/** Each tile's tabs, in reading order. */
const tiles = (arrangement: Arrangement) => tilesOf(arrangement.root).map((tile) => tile.tabs);

describe("applying a layout", () => {
  it("fills conversation places with the page's session first, and opens the views it names", () => {
    const applied = applyLayout(
      oneTile([other, own], other),
      builtIn("two-sessions-over-terminal"),
      context,
    );
    expect(tiles(applied)).toEqual([[own], [other], [terminal]]);
  });

  it("loses no open tab: what it didn't place joins its first conversation's tile, not showing", () => {
    const before = oneTile([own, other, third, "view:preview", "new:1"], third);
    const applied = applyLayout(before, builtIn("change-over-terminal"), context);
    expect(tiles(applied)).toEqual([
      [own, other, third, "view:preview", "new:1"],
      [change],
      [terminal],
    ]);
    expect(tilesOf(applied.root)[0]?.active).toBe(own);
    expect(new Set(tabsOf(applied))).toEqual(new Set([...tabsOf(before), change, terminal]));
  });

  it("drops a place nothing fills, and its tile gives way to its neighbour", () => {
    const applied = applyLayout(
      oneTile([own], own),
      builtIn("two-sessions-over-terminal"),
      context,
    );
    expect(tiles(applied)).toEqual([[own], [terminal]]);
    expect(applied.root).toMatchObject({ kind: "split", direction: "column", sizes: [65, 35] });
  });

  it("skips a view this app doesn't have, keeping the rest", () => {
    const layout: TileLayout = {
      version: 1,
      root: {
        kind: "split",
        direction: "row",
        children: [
          { kind: "tile", tabs: [{ kind: "session" }], active: 0 },
          { kind: "tile", tabs: [{ kind: "view", view: "screen" }], active: 0 },
        ],
        sizes: [50, 50],
      },
      focus: 1,
    };
    const applied = applyLayout(oneTile([own], own), layout, context);
    expect(tiles(applied)).toEqual([[own]]);
    // The focused tile left: the first tile takes focus.
    expect(applied.focus).toBe(tilesOf(applied.root)[0]?.id);
  });

  it("puts a maximised tile back, and focuses the tile the layout focuses", () => {
    const split = splitTile(oneTile([own, change], own), "t1", change, "right");
    const applied = applyLayout(
      { ...split, maximised: "t1" },
      { ...builtIn("conversation-beside-change"), focus: 1 },
      context,
    );
    expect(applied.maximised).toBeNull();
    expect(tilesOf(applied.root).find((tile) => tile.id === applied.focus)?.tabs).toEqual([change]);
  });
});

describe("saving the sheet as a layout", () => {
  it("keeps the tiles, their sizes and kinds of tab, never which session, and reads back the same", () => {
    const sheet = applyLayout(oneTile([own, other], own), builtIn("change-over-terminal"), context);
    const saved = layoutOfArrangement(sheet);
    expect(saved).toEqual({
      version: 1,
      root: {
        kind: "split",
        direction: "row",
        children: [
          { kind: "tile", tabs: [{ kind: "session" }, { kind: "session" }], active: 0 },
          {
            kind: "split",
            direction: "column",
            children: [
              { kind: "tile", tabs: [{ kind: "view", view: "change" }], active: 0 },
              { kind: "tile", tabs: [{ kind: "view", view: "terminal" }], active: 0 },
            ],
            sizes: [60, 40],
          },
        ],
        sizes: [50, 50],
      },
      focus: 0,
    });
    if (saved === null) return;
    // In another workspace, with other sessions, it is the same arrangement.
    const elsewhere = applyLayout(oneTile(["session:x", "session:y"], "session:x"), saved, {
      ...context,
      own: "session:x",
    });
    expect(tiles(elsewhere)).toEqual([["session:x", "session:y"], [change], [terminal]]);
  });

  it("leaves out a New session tab, and a tile that held only that", () => {
    const sheet = splitTile(oneTile([own, "new:1"], own), "t1", "new:1", "right");
    expect(layoutOfArrangement(sheet)?.root).toEqual({
      kind: "tile",
      tabs: [{ kind: "session" }],
      active: 0,
    });
  });
});

describe("the menu's check mark", () => {
  it("marks the layout the sheet shows, sizes aside, and no other", () => {
    const sheet = applyLayout(oneTile([own, other], own), builtIn("change-over-terminal"), context);
    const marked = BUILT_IN_LAYOUTS.filter((each) => showsLayout(sheet, each.layout, context)).map(
      (each) => each.id,
    );
    expect(marked).toEqual(["change-over-terminal"]);
  });
});

describe("reset to one tile", () => {
  it("puts every tab in one tile, the focused tab showing", () => {
    const sheet = applyLayout(oneTile([own, other], own), builtIn("change-over-terminal"), context);
    const focused = { ...sheet, focus: tilesOf(sheet.root)[2]?.id ?? "" };
    const reset = oneTileOf(focused);
    expect(tiles(reset)).toEqual([[own, other, change, terminal]]);
    expect(tilesOf(reset.root)[0]?.active).toBe(terminal);
  });
});
