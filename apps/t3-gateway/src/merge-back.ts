import {
  ContextHandoffId,
  ContextTransferId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";

import {
  appThreadOf,
  providerThreadIdOf,
  runIdOf,
  turnNodeIdOf,
  utc,
  type ThreadSource,
} from "./shell.ts";

/** Durable transfers and their delivery evidence use the same IDs after gateway restart. */
export function mergeBackProjectionOf(source: ThreadSource) {
  const transfers: OrchestrationV2ContextTransfer[] = [];
  const handoffs: OrchestrationV2ContextHandoff[] = [];
  const items: OrchestrationV2TurnItem[] = [];
  const thread = appThreadOf(source);
  for (const transfer of source.nativeHistory?.mergeBack ?? []) {
    const ids = source.mergeBackIds?.get(transfer.id);
    const id = ContextTransferId.make(transfer.id);
    const handoffId = ContextHandoffId.make(`merge-back:${id}`);
    const targetTurn =
      transfer.state.kind === "consumed"
        ? source.turns.find(
            (turn) => transfer.state.kind === "consumed" && turn.id === transfer.state.turnId,
          )
        : undefined;
    const targetRunId = targetTurn === undefined ? null : runIdOf(source, targetTurn);
    const createdAt = utc(transfer.createdAt.toISOString());
    const consumedAt =
      transfer.state.kind === "consumed" ? utc(transfer.state.consumedAt.toISOString()) : null;
    const at = consumedAt ?? createdAt;
    transfers.push({
      id,
      type: "merge_back",
      sourceThreadId: ids?.threadId ?? ThreadId.make(transfer.sourceSessionId),
      targetThreadId: thread.id,
      sourcePoint: {
        threadId: ids?.threadId ?? ThreadId.make(transfer.sourceSessionId),
        runId: ids?.runId ?? RunId.make(transfer.sourceTurnId),
      },
      basePoint: null,
      sourceProviderInstanceId: null,
      targetProviderInstanceId: thread.providerInstanceId,
      targetRunId,
      status: transfer.state.kind,
      resolution:
        targetRunId === null
          ? null
          : { strategy: "fork_delta_context", contextHandoffId: handoffId },
      createdBy: "user",
      error: null,
      createdAt,
      updatedAt: at,
      consumedAt,
    });
    if (targetTurn === undefined || targetRunId === null) continue;
    const toProviderThreadId = providerThreadIdOf(source.session);
    handoffs.push({
      id: handoffId,
      transferId: id,
      threadId: thread.id,
      targetRunId,
      fromProviderThreadIds: [],
      toProviderThreadId,
      coveredRunOrdinals: { from: 1, to: transfer.sourceOrdinal + 1 },
      strategy: "fork_delta_summary",
      status: "ready",
      summaryMessageId: null,
      summaryText: transfer.summary,
      detailInTurnItem: true,
      createdByProviderInstanceId: null,
      createdAt,
      updatedAt: at,
    });
    items.push({
      id: TurnItemId.make(handoffId),
      type: "handoff",
      threadId: thread.id,
      runId: targetRunId,
      nodeId: turnNodeIdOf(targetTurn.id),
      providerThreadId: toProviderThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: (targetTurn.ordinal + 1) * 100_000 + 1,
      status: "completed",
      title: "Fork context",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      contextHandoffId: handoffId,
      fromProviderThreadIds: [],
      toProviderThreadId,
      fromProviderInstanceIds: [],
      toProviderInstanceId: thread.providerInstanceId,
      strategy: "fork_delta_summary",
      summary: transfer.summary,
    });
  }
  return { transfers, handoffs, items };
}
