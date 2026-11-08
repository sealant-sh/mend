import { describe, expect, it } from "vitest";

import { selectionMatches, turnSelectionOf } from "./turn-selection.ts";

describe("turn permission selection", () => {
  it("compares explicit permission choices while preserving legacy retry receipts", () => {
    const legacy = turnSelectionOf("codex", "test", "high");
    if (legacy === null) throw new Error("Missing Codex selection");
    expect(
      selectionMatches(
        { ...legacy, permissionMode: "ask" },
        { ...legacy, permissionMode: "bypass" },
      ),
    ).toBe(false);
    expect(selectionMatches(legacy, legacy)).toBe(true);
    expect(selectionMatches(undefined, { ...legacy, permissionMode: "ask" })).toBe(true);
  });
});
