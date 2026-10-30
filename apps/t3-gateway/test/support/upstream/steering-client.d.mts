import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
} from "@mend/t3-contracts";

export function deriveThreadQueueWorkflowState(projection: OrchestrationV2ThreadProjection): {
  readonly canPromoteToSteer: boolean;
  readonly canSendNow: boolean;
  readonly isHeld: boolean;
};
export function applyOrchestrationV2ProjectionEvent(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection;
