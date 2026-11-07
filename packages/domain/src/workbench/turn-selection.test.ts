import { describe, expect, it } from "vitest";

import { selectionMatches, turnSelectionOf, turnSelectionRefusal } from "./turn-selection.ts";

describe("turn speed selection", () => {
  it("includes speed in a keyed retry's identity", () => {
    const standard = turnSelectionOf("codex", "gpt-test", "high");
    if (standard === null) throw new Error("Codex selection missing");
    const fast = { ...standard, speed: "fast" } as const;
    expect(selectionMatches(fast, standard)).toBe(false);
    expect(selectionMatches({ ...standard, speed: "standard" }, standard)).toBe(true);
    expect(selectionMatches(undefined, fast)).toBe(true);
  });

  it("refuses Fast on Claude before a provider control or prompt", () => {
    const selection = turnSelectionOf("claude", "opus", "high");
    if (selection === null) throw new Error("Claude selection missing");
    expect(turnSelectionRefusal("claude", { ...selection, speed: "fast" })).toContain("Fast");
  });
});
