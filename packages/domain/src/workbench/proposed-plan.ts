import { Schema } from "effect";

/** Discriminates a native proposal from task lists sharing the plan item kind. */
export const AgentProposedPlanData = Schema.TaggedStruct("ProposedPlan", {});
export type AgentProposedPlanData = typeof AgentProposedPlanData.Type;

/** Read the sole markdown field only when the item is a typed, nonempty proposal. */
export function proposedPlanContentOf(item: {
  readonly kind: string;
  readonly text: string | null;
  readonly data: unknown;
}): { readonly markdown: string } | null {
  return item.kind === "plan" && Schema.is(AgentProposedPlanData)(item.data) && item.text?.trim()
    ? { markdown: item.text }
    : null;
}
