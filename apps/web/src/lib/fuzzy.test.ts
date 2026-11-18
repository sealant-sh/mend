import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyMatch } from "#/lib/fuzzy";

describe("fuzzyMatch", () => {
  it("matches the query's characters in order, ignoring case", () => {
    expect(fuzzyMatch("stab", "settings-tabs")?.indices).toEqual([0, 2, 10, 11]);
    expect(fuzzyMatch("MEND", "mend")).not.toBeNull();
    expect(fuzzyMatch("bats", "settings-tabs")).toBeNull();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("marks the query where it appears whole, at a word start before inside a word", () => {
    // Greedy matching would take the l of "Fix flaky" and scatter the rest.
    expect(fuzzyMatch("land", "Fix flaky landing")?.indices).toEqual([10, 11, 12, 13]);
    expect(fuzzyMatch("ref", "Prefer refunds")?.indices).toEqual([7, 8, 9]);
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
