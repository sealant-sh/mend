import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  proposedPlanContentOf,
  selectionMatches,
  TurnSelection,
  turnSelectionOf,
} from "../src/workbench/index.ts";

describe("recorded planning choices", () => {
  it("decodes legacy choices without inventing a selection for unrecorded turns", () => {
    const decode = Schema.decodeUnknownSync(Schema.NullOr(TurnSelection));
    expect(decode(null)).toBeNull();
    expect(decode({ harness: "codex", model: null, effort: null })).toEqual({
      harness: "codex",
      model: null,
      effort: null,
      interactionMode: "default",
    });
    expect(() =>
      decode({ harness: "codex", model: null, effort: null, interactionMode: null }),
    ).toThrow();
    expect(() =>
      decode({ harness: "codex", model: null, effort: null, interactionMode: "auto" }),
    ).toThrow();
  });
  it("keeps default and Plan distinct when comparing a keyed retry", () => {
    const plan = turnSelectionOf("claude", null, "high", "plan");
    const reset = turnSelectionOf("claude", null, "high");
    expect(plan?.interactionMode).toBe("plan");
    expect(reset?.interactionMode).toBe("default");
    expect(selectionMatches(plan ?? undefined, reset)).toBe(false);
    expect(selectionMatches(undefined, plan)).toBe(true);
  });
  it("recognizes only typed, nonempty proposed plans", () => {
    const item = {
      kind: "plan" as const,
      text: "# Proposal\n\nDo this",
      data: { _tag: "ProposedPlan" },
    };
    expect(proposedPlanContentOf(item)).toEqual({ markdown: item.text });
    expect(proposedPlanContentOf({ ...item, data: { steps: [] } })).toBeNull();
    expect(proposedPlanContentOf({ ...item, text: " \n" })).toBeNull();
    expect(proposedPlanContentOf({ ...item, kind: "tool-call" })).toBeNull();
  });
});
