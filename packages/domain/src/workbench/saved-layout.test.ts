import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SavedLayoutName, TileLayout, savedLayoutNameIssue } from "./saved-layout.ts";

const decode = (value: unknown) =>
  Schema.decodeUnknownExit(TileLayout, { onExcessProperty: "error" })(value);

const conversation = { kind: "session" } as const;
const view = (id: string) => ({ kind: "view", view: id }) as const;
const tile = (tabs: ReadonlyArray<unknown>, active = 0) => ({ kind: "tile", tabs, active });
const split = (direction: "row" | "column", children: ReadonlyArray<unknown>) => ({
  kind: "split",
  direction,
  children,
  sizes: children.map(() => 100 / children.length),
});

/** T18's "Change over terminal": a conversation beside Change over Terminal, Change focused. */
const changeOverTerminal = {
  version: 1,
  root: split("row", [
    tile([conversation, conversation], 1),
    split("column", [tile([view("change")]), tile([view("terminal")])]),
  ]),
  focus: 1,
};

/** A split `levels` deep, each level a split of a tile and the next level. */
const nested = (levels: number): unknown =>
  levels === 0 ? tile([conversation]) : split("row", [tile([conversation]), nested(levels - 1)]);

describe("TileLayout", () => {
  it("reads back exactly the layout it stored", () => {
    const decoded = Schema.decodeUnknownSync(TileLayout)(changeOverTerminal);
    expect(Schema.encodeSync(TileLayout)(decoded)).toEqual(changeOverTerminal);
  });

  it("takes splits four deep and eight tiles, its limits", () => {
    expect(Exit.isSuccess(decode({ version: 1, root: nested(4), focus: 4 }))).toBe(true);
    const eight = split(
      "row",
      Array.from({ length: 8 }, () => tile([conversation])),
    );
    expect(Exit.isSuccess(decode({ version: 1, root: eight, focus: 7 }))).toBe(true);
  });

  it.each([
    ["a version it doesn't know", { ...changeOverTerminal, version: 2 }],
    ["no version", { root: changeOverTerminal.root, focus: 0 }],
    ["a showing tab past the tile's tabs", { version: 1, root: tile([conversation], 1), focus: 0 }],
    ["a focused tile past the layout's tiles", { ...changeOverTerminal, focus: 3 }],
    [
      "a split with a size missing",
      {
        version: 1,
        root: { ...split("row", [tile([conversation]), tile([view("change")])]), sizes: [100] },
        focus: 0,
      },
    ],
    [
      "a size of nothing",
      {
        version: 1,
        root: { ...split("row", [tile([conversation]), tile([view("change")])]), sizes: [100, 0] },
        focus: 0,
      },
    ],
    [
      "nine tiles",
      {
        version: 1,
        root: split("column", [
          split(
            "row",
            Array.from({ length: 5 }, () => tile([conversation])),
          ),
          split(
            "row",
            Array.from({ length: 4 }, () => tile([conversation])),
          ),
        ]),
        focus: 0,
      },
    ],
    ["splits five deep", { version: 1, root: nested(5), focus: 0 }],
    ["an empty tile", { version: 1, root: tile([]), focus: 0 }],
    ["a split of one child", { version: 1, root: split("row", [tile([conversation])]), focus: 0 }],
    ["a particular session", { version: 1, root: tile([{ kind: "session", id: 7 }]), focus: 0 }],
    ["a kind of tab it doesn't know", { version: 1, root: tile([{ kind: "new" }]), focus: 0 }],
    ["a view id that isn't one", { version: 1, root: tile([view("../change")]), focus: 0 }],
  ])("refuses %s", (_, value) => {
    expect(Exit.isFailure(decode(value))).toBe(true);
  });
});

describe("a saved layout's name", () => {
  it("is up to 48 characters, counted as a person sees them", () => {
    expect(savedLayoutNameIssue("Review with terminal")).toBeNull();
    expect(savedLayoutNameIssue("🧪".repeat(48))).toBeNull();
    expect(savedLayoutNameIssue("a".repeat(49))).not.toBeNull();
  });

  it.each([
    ["empty", ""],
    ["spaces at either end", " Review "],
    ["a line break", "Review\nwith terminal"],
    ["a C1 control character", "Review\u0085"],
  ])("refuses a name with %s", (_, name) => {
    expect(savedLayoutNameIssue(name)).not.toBeNull();
    expect(Exit.isFailure(Schema.decodeUnknownExit(SavedLayoutName)(name))).toBe(true);
  });
});
