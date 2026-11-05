import type { SessionHistoryView } from "@mend/domain/workbench";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
const utc = DateTime.makeUnsafe;

/** Both shell builders use core provenance. Native paths and seeds never become client IDs. */
export function threadLineageOf(
  id: ThreadId,
  history: SessionHistoryView | null = null,
  ids: {
    readonly source: ThreadId;
    readonly root: ThreadId;
    readonly sourceRun?: RunId;
  } | null = null,
): Pick<OrchestrationV2AppThread, "lineage" | "forkedFrom"> {
  const fork = history?.fork;
  if (fork === undefined || fork === null)
    return {
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
    };
  const parent = ids?.source ?? ThreadId.make(fork.provenance.sourceSessionId);
  return {
    lineage: {
      parentThreadId: parent,
      relationshipToParent: "fork",
      rootThreadId: ids?.root ?? ThreadId.make(fork.provenance.rootSessionId),
    },
    forkedFrom:
      fork.provenance.sourceTurnId === null
        ? null
        : {
            type: "run",
            threadId: parent,
            runId: ids?.sourceRun ?? RunId.make(fork.provenance.sourceTurnId),
          },
  };
}

/** Inherited evidence is read-only, with no child run, attempt, provider execution or cost. */
export function inheritedProjectionOf(
  history: SessionHistoryView | null | undefined,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  const rows: OrchestrationV2ProjectedTurnItem[] = [];
  for (const turn of history?.fork?.history ?? []) {
    const threadId = ThreadId.make(turn.sourceSessionId);
    const at = utc(turn.createdAt.toISOString());
    const end = turn.endedAt === null ? at : utc(turn.endedAt.toISOString());
    const add = (
      key: string,
      content: {
        readonly type: "user_message" | "assistant_message" | "reasoning";
        readonly text: string;
      },
    ) => {
      const id = TurnItemId.make(`inherited:${turn.sourceSessionId}:${turn.sourceTurnId}:${key}`);
      const base = {
        id,
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: rows.length,
        status: "completed",
        title: "Inherited conversation evidence",
        startedAt: at,
        completedAt: end,
        updatedAt: end,
      } as const;
      const item: OrchestrationV2TurnItem =
        content.type === "user_message"
          ? {
              ...base,
              type: "user_message",
              createdBy: "user",
              creationSource: "server",
              messageId: MessageId.make(id),
              inputIntent: "turn_start",
              text: content.text,
              attachments: [],
            }
          : content.type === "assistant_message"
            ? {
                ...base,
                type: "assistant_message",
                messageId: MessageId.make(id),
                text: content.text,
                streaming: false,
              }
            : { ...base, type: "reasoning", text: content.text, streaming: false };
      rows.push({
        position: rows.length,
        visibility: "inherited",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make(key === "input" ? `input:${turn.sourceTurnId}` : key),
        item,
      });
    };
    add("input", { type: "user_message", text: turn.input });
    for (const item of turn.items)
      if (item.text !== null)
        add(item.id, {
          type:
            item.kind === "assistant-message"
              ? "assistant_message"
              : item.kind === "user-message"
                ? "user_message"
                : "reasoning",
          text: item.text,
        });
  }
  return rows;
}
