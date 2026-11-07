import { InteractionMode, proposedPlanContentOf, TurnSelection } from "@mend/domain/workbench";
import {
  OrchestrationMessageContext,
  NodeId,
  PlanId,
  RunId,
  type OrchestrationV2PlanArtifact,
} from "@mend/t3-contracts";
import { Schema } from "effect";

import type { MendItem } from "./mend-workbench.ts";
import type { ThreadSource } from "./shell.ts";

/** Canonical source identity, scoped by the actor owning its metadata. */
export const KeptSourcePlan = Schema.Struct({
  sessionId: Schema.String,
  turnId: Schema.String,
  itemId: Schema.String,
});
export type KeptSourcePlan = typeof KeptSourcePlan.Type;

/** An admitted implementation consumes its source even if the destination is later removed. */
export const PlanImplementation = Schema.Struct({
  actorId: Schema.String,
  source: KeptSourcePlan,
  targetSessionId: Schema.String,
  runId: Schema.String,
  messageId: Schema.String,
  admittedAt: Schema.String,
});
export type PlanImplementation = typeof PlanImplementation.Type;

/** A keyed dispatch receipt permits exact replay after the transient queue entry is removed. */
export const PlanningAdmission = Schema.Struct({
  messageId: Schema.String,
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  imageIds: Schema.Array(Schema.String),
  selection: Schema.NullOr(TurnSelection),
  source: Schema.NullOr(KeptSourcePlan),
});
export type PlanningAdmission = typeof PlanningAdmission.Type;

/** Actor/session preferences and canonical references stored in the gateway's existing meta JSON. */
export const ThreadPlanningState = Schema.Struct({
  interactionMode: InteractionMode,
  implementations: Schema.Array(PlanImplementation),
  admissions: Schema.Array(PlanningAdmission),
});
export type ThreadPlanningState = typeof ThreadPlanningState.Type;

/** No saved preference means ordinary native interaction. Explicit resets remain saved. */
export const emptyPlanning = (): ThreadPlanningState => ({
  interactionMode: "default",
  implementations: [],
  admissions: [],
});

/** Stable proposal identity shared by artifacts, cards and implementation references. */
export const planIdOf = (itemId: string): PlanId => PlanId.make(`mend-plan:${itemId}`);

/** One derivation of actionable proposal evidence for both shell and full thread. */
export function proposedPlansOf(
  source: ThreadSource,
  items: ReadonlyArray<MendItem>,
): ReadonlyArray<OrchestrationV2PlanArtifact> {
  return items.flatMap((item) => {
    const content = proposedPlanContentOf(item);
    const turn = source.turns.find((candidate) => candidate.id === item.turnId);
    if (content === null || turn === undefined) return [];
    const consumed =
      source.planning?.implementations.some(
        (ref) =>
          ref.source.sessionId === source.session.id &&
          ref.source.turnId === item.turnId &&
          ref.source.itemId === item.id,
      ) === true;
    return [
      {
        id: planIdOf(item.id),
        threadId: source.threadId,
        runId: RunId.make(source.runIds.get(turn.id) ?? turn.id),
        nodeId: NodeId.make(`node:turn:${turn.id}`),
        kind: "proposed_plan" as const,
        markdown: content.markdown,
        status: consumed
          ? ("completed" as const)
          : item.status === "completed" &&
              turn.status !== "failed" &&
              turn.status !== "interrupted" &&
              turn.status !== "cancelled"
            ? ("active" as const)
            : ("draft" as const),
      },
    ];
  });
}
