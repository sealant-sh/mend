import { ConversationWaitWork } from "@mend/domain/workbench";
import type { OrchestrationV2ThreadProjection } from "@mend/t3-contracts";
import { Option, Schema } from "effect";

import type { MendConversationWait } from "./mend-workbench.ts";

/** Why a native task cannot be ended through Mend. */
export class NativeWorkStopRefused extends Error {
  readonly _tag = "NativeWorkStopRefused";
}

const decodeKind = Schema.decodeUnknownOption(ConversationWaitWork.fields.kind);

/** A provider-owned piece of work Mend can end as the signed-in person. */
export type NativeWorkStop = Pick<ConversationWaitWork, "kind" | "id">;

/** Resolve a card's native task id from the person's visible projection, never from client input. */
export const nativeTaskStopTarget = (
  projection: OrchestrationV2ThreadProjection,
  subagentId: string,
  runId?: string,
): NativeWorkStop | NativeWorkStopRefused => {
  const agent = projection.subagents.find((candidate) => candidate.id === subagentId);
  if (agent === undefined || (runId !== undefined && agent.runId !== runId))
    return new NativeWorkStopRefused("That native task is not in this run.");
  if (agent.status !== "running" && agent.status !== "waiting" && agent.status !== "pending")
    return new NativeWorkStopRefused("This native task is no longer running.");
  if (agent.nativeTaskRef?.nativeId == null)
    return new NativeWorkStopRefused("This task has no live provider task id.");
  if (agent.driver !== "claude")
    return new NativeWorkStopRefused("Mend cannot stop this provider's native child yet.");
  return { kind: "task", id: agent.nativeTaskRef.nativeId };
};

/** The supported work to stop, with refusals retained so a partial stop is reported honestly. */
export interface NativeBackgroundStops {
  readonly targets: ReadonlyArray<NativeWorkStop>;
  readonly refusals: ReadonlyArray<NativeWorkStopRefused>;
}

/** Thread Stop includes earlier recorded tasks and exactly the endable work Mend reports waiting on. */
export const nativeBackgroundStopsOf = (
  projection: OrchestrationV2ThreadProjection,
  waiting: MendConversationWait | null,
): NativeBackgroundStops => {
  const stops = new Map<string, NativeWorkStop>();
  const refusals: Array<NativeWorkStopRefused> = [];
  const seen = new Set<string>();
  const driver = projection.providerSessions[0]?.driver;
  for (const work of waiting?.work ?? []) {
    seen.add(work.id);
    const kind = decodeKind(work.kind);
    if (work.endable !== true || Option.isNone(kind)) {
      refusals.push(
        new NativeWorkStopRefused("Mend cannot end this waiting work. It must finish on its own."),
      );
      continue;
    }
    stops.set(work.id, { kind: kind.value, id: work.id });
  }
  for (const thread of projection.providerThreads) {
    for (const work of thread.pendingBackgroundTasks ?? []) {
      if (seen.has(work.taskId)) continue;
      seen.add(work.taskId);
      if (driver === "codex" && work.kind !== "command") {
        refusals.push(
          new NativeWorkStopRefused("Mend cannot stop this provider's native child yet."),
        );
        continue;
      }
      stops.set(work.taskId, {
        kind: driver === "codex" ? "terminal" : work.kind === "monitor" ? "monitor" : "task",
        id: work.taskId,
      });
    }
  }
  return { targets: Array.from(stops.values()), refusals };
};
