import { AgentItemId, type AgentTurnId, type ScreenId, type SessionId } from "@mend/domain";
import { ScreenEpisode, type ScreenLogEntry } from "@mend/domain/workbench";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";

import type { MendDatabase } from "../client.ts";
import { agentItems, screenLog } from "../schema/workbench.ts";
import { lockAgentConversation, nextAgentItemSeq } from "./agent-conversation.ts";

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "execute">;

const decodeEpisode = Schema.decodeUnknownSync(ScreenEpisode);
const encodeEpisode = Schema.encodeSync(ScreenEpisode);

export const screenEpisodeProviderId = (screenId: ScreenId, turnId: AgentTurnId): string =>
  `mend-screen:${screenId}:${turnId}`;

const doneActions = (entry: ScreenLogEntry): number =>
  entry.body._tag === "Acted"
    ? entry.body.notes.filter((note) => note.result === "done").length
    : 0;

/**
 * Grows the turn's `screen` item by an agent's entry, in the entry's transaction: one item per
 * screen and turn, spanning its entries, never holding a frame. False for an entry with no turn.
 */
export const ensureScreenEpisode = Effect.fn("ScreensRepo.ensureScreenEpisode")(function* (
  tx: Tx,
  sessionId: SessionId,
  entry: ScreenLogEntry,
) {
  const { actor } = entry;
  if (actor._tag !== "Agent" || actor.turnId === null) return false;
  const { processId } = actor;
  const turnId = actor.turnId;
  yield* lockAgentConversation(tx, sessionId);
  const providerItemId = screenEpisodeProviderId(entry.screenId, turnId);
  const [existing] = yield* tx
    .select({ id: agentItems.id, data: agentItems.data })
    .from(agentItems)
    .where(and(eq(agentItems.processId, processId), eq(agentItems.providerItemId, providerItemId)));
  const before = existing === undefined ? null : decodeEpisode(existing.data);
  const [taken] =
    before === null
      ? []
      : yield* tx
          .select({ seq: screenLog.seq })
          .from(screenLog)
          .where(
            and(
              eq(screenLog.screenId, entry.screenId),
              gt(screenLog.seq, before.span.toSeq),
              lt(screenLog.seq, entry.seq),
              sql`${screenLog.body} ->> '_tag' = 'Taken'`,
            ),
          )
          .limit(1);
  const episode: ScreenEpisode = {
    span: {
      screenId: entry.screenId,
      fromSeq: before?.span.fromSeq ?? entry.seq,
      toSeq: entry.seq,
    },
    actions: (before?.actions ?? 0) + doneActions(entry),
    frames: (before?.frames ?? 0) + (entry.frame === null ? 0 : 1),
    coverFrameId: entry.frame?.id ?? before?.coverFrameId ?? null,
    personHeld: (before?.personHeld ?? false) || taken !== undefined,
  };
  const seq = yield* nextAgentItemSeq(tx, sessionId);
  if (existing !== undefined) {
    yield* tx
      .update(agentItems)
      .set({ data: encodeEpisode(episode), seq, updatedAt: yield* DateTime.nowAsDate })
      .where(eq(agentItems.id, existing.id));
    return true;
  }
  yield* tx.insert(agentItems).values({
    id: AgentItemId.make(crypto.randomUUID()),
    sessionId,
    processId,
    turnId,
    seq,
    providerItemId,
    providerOutputProcessId: processId,
    providerOutputSeq: 0n,
    providerEventIndex: 0,
    kind: "screen",
    status: "completed",
    title: "screen",
    text: null,
    data: encodeEpisode(episode),
  });
  return true;
});
