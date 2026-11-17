import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches the query's characters in order, ignoring case", () => {
    expect(fuzzyMatch("stab", "settings-tabs")?.indices).toEqual([0, 2, 10, 11]);
    expect(fuzzyMatch("MEND", "mend")).not.toBeNull();
    expect(fuzzyMatch("bats", "settings-tabs")).toBeNull();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("fuzzyFilter", () => {
  const branches = ["main", "t3/settings-tabs", "fix/tab-order", "release/0.37"];

  it("ranks a run of adjacent characters at a word start above a scattered match", () => {
    expect(fuzzyFilter(branches, "tab", (branch) => branch).map(({ item }) => item)).toEqual([
      "fix/tab-order",
      "t3/settings-tabs",
    ]);
  });

  it("keeps the given order when the query is empty", () => {
    expect(fuzzyFilter(branches, "", (branch) => branch).map(({ item }) => item)).toEqual(branches);
  });
});
