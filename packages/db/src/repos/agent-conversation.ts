import { PgClient } from "@effect/sql-pg";
import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  type ChangeLandingId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  AgentItem,
  AgentRequest,
  AgentTurn,
  OPEN_AGENT_TURN_STATUSES,
  type AgentApprovalDecision,
  type AgentEventItem,
  type AgentEventRequest,
  type AgentInputAnswers,
  type AgentTurnStatus,
  type AgentTurnUsage,
  type RequestIntentReading,
  type TurnLanding,
} from "@mend/domain/workbench";
import { and, asc, eq, gt, inArray, isNull, max, notInArray, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentItems,
  agentRequests,
  agentSessions,
  agentTurns,
  sessionProcesses,
} from "../schema/workbench.ts";

/** A requested protocol turn does not exist. */
export class AgentTurnNotFoundError extends Schema.TaggedErrorClass<AgentTurnNotFoundError>()(
  "AgentTurnNotFoundError",
  { turnId: Schema.String },
) {}

/** A requested agent-to-human request does not exist. */
export class AgentRequestNotFoundError extends Schema.TaggedErrorClass<AgentRequestNotFoundError>()(
  "AgentRequestNotFoundError",
  { requestId: Schema.String },
) {}

/** A request already has a recorded answer or cancellation. */
export class AgentRequestAlreadyResolvedError extends Schema.TaggedErrorClass<AgentRequestAlreadyResolvedError>()(
  "AgentRequestAlreadyResolvedError",
  { requestId: Schema.String },
) {}

/** Input required to persist one replay-safe item update. */
export interface UpsertAgentItemInput extends AgentEventItem {
  readonly sessionId: SessionId;
  readonly processId: SessionProcessId;
  readonly turnId: AgentTurnId;
  /** Native pipe output position; repeated positions are replay and do not move the item cursor. */
  readonly providerOutputSeq: bigint;
  readonly providerEventIndex: number;
}

/** One PTY-era turn reconstructed from the native transcript, ready to land as history. */
export interface BackfillTurnInput {
  /** Deterministic provider turn id (`native:<entry id>`); the idempotency key. */
  readonly providerTurnId: string;
  readonly input: string;
  readonly items: ReadonlyArray<AgentEventItem>;
}

/** Input required to persist one replay-safe request. */
export interface OpenAgentRequestInput extends AgentEventRequest {
  readonly sessionId: SessionId;
  readonly processId: SessionProcessId;
  readonly turnId: AgentTurnId;
}

/** The durable output position after a fully projected NDJSON line boundary. */
export interface AgentProtocolCursor {
  readonly nextSequence: bigint;
}

/** Approval or structured-input response recorded for one request. */
export type ResolveAgentRequestInput =
  | { readonly decision: AgentApprovalDecision; readonly answers?: never }
  | { readonly answers: AgentInputAnswers; readonly decision?: never };

/**
 * Durable structured conversation state. Provider identities are database keys so replay updates
 * existing rows. `seq` is a session-wide change-feed cursor, not conversation order: every applied
 * update moves the item to the tail so `listItems(after)` re-delivers changed items; render order
 * is `createdAt` (or turn ordinal). Allocation happens under a per-session advisory lock.
 */
export class AgentConversationRepo extends Context.Service<
  AgentConversationRepo,
  {
    readonly submitTurn: (
      sessionId: SessionId,
      processId: SessionProcessId,
      input: string,
      author: string | null,
      launchCorrelationId?: string | null,
    ) => Effect.Effect<AgentTurn>;
    readonly byTurnId: (id: AgentTurnId) => Effect.Effect<AgentTurn | null>;
    readonly byLaunchCorrelation: (
      sessionId: SessionId,
      launchCorrelationId: string,
    ) => Effect.Effect<AgentTurn | null>;
    readonly byProviderTurnId: (
      sessionId: SessionId,
      providerTurnId: string,
    ) => Effect.Effect<AgentTurn | null>;
    readonly listTurns: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<AgentTurn>>;
    /** Every queued or running turn, oldest first. */
    readonly openTurns: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<AgentTurn>>;
    readonly claimNextTurn: (processId: SessionProcessId) => Effect.Effect<AgentTurn | null>;
    readonly setProviderTurnId: (
      id: AgentTurnId,
      providerTurnId: string,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    /** Correlate a provider notification with the one running Mend turn. */
    readonly bindRunningProviderTurn: (
      sessionId: SessionId,
      processId: SessionProcessId,
      providerTurnId: string,
    ) => Effect.Effect<AgentTurn | null>;
    readonly failTurn: (
      id: AgentTurnId,
      error: string,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    /**
     * What the turn's request asked for (docs/adr/0007-landing.md), read once per turn and
     * replaced whole when read again.
     */
    readonly setTurnIntent: (
      id: AgentTurnId,
      reading: RequestIntentReading,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    /**
     * Claim an ended turn for the automatic-landing decision (docs/adr/0007-landing.md), once:
     * the turn when this call claimed it, null when it is still open, already claimed, or gone.
     */
    readonly claimTurnLanding: (id: AgentTurnId) => Effect.Effect<AgentTurn | null>;
    /** Record what Mend decided about a claimed turn, and the landing it started, if any. */
    readonly decideTurnLanding: (
      id: AgentTurnId,
      landing: TurnLanding,
      landingId: ChangeLandingId | null,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    readonly completeTurn: (
      providerTurnId: string,
      sessionId: SessionId,
      status: Exclude<AgentTurnStatus, "queued" | "running">,
      usage: AgentTurnUsage | null,
      error: string | null,
    ) => Effect.Effect<AgentTurn | null>;
    readonly upsertItem: (input: UpsertAgentItemInput) => Effect.Effect<AgentItem>;
    readonly listItems: (
      sessionId: SessionId,
      after: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AgentItem>>;
    /** What the agent said in one turn: its messages and plans, in conversation order. */
    readonly turnMessages: (turnId: AgentTurnId) => Effect.Effect<ReadonlyArray<AgentItem>>;
    readonly openRequest: (input: OpenAgentRequestInput) => Effect.Effect<AgentRequest>;
    readonly byRequestId: (id: AgentRequestId) => Effect.Effect<AgentRequest | null>;
    readonly listRequests: (
      sessionId: SessionId,
      pendingOnly: boolean,
    ) => Effect.Effect<ReadonlyArray<AgentRequest>>;
    readonly hasPendingRequests: (sessionId: SessionId) => Effect.Effect<boolean>;
    readonly prepareRequestResponse: (
      id: AgentRequestId,
      response: ResolveAgentRequestInput,
      decidedBy: string,
    ) => Effect.Effect<AgentRequest, AgentRequestNotFoundError | AgentRequestAlreadyResolvedError>;
    readonly completeRequestResponse: (
      id: AgentRequestId,
    ) => Effect.Effect<AgentRequest, AgentRequestNotFoundError>;
    readonly failRequestResponse: (id: AgentRequestId) => Effect.Effect<void>;
    readonly resolveRequest: (
      id: AgentRequestId,
      response: ResolveAgentRequestInput,
      decidedBy: string,
    ) => Effect.Effect<AgentRequest, AgentRequestNotFoundError | AgentRequestAlreadyResolvedError>;
    readonly resolveProviderRequest: (
      processId: SessionProcessId,
      providerRequestId: string,
    ) => Effect.Effect<void>;
    readonly cancelOpenForTurn: (turnId: AgentTurnId) => Effect.Effect<void>;
    readonly cancelOpenForProcess: (processId: SessionProcessId) => Effect.Effect<void>;
    /**
     * Mode handoff: land PTY-era turns from the native transcript as completed
     * history. One transaction under the session lock; ordinals append after
     * the existing tail; a turn whose providerTurnId already exists is
     * skipped, so a repeated backfill is a no-op. Returns the turns landed.
     */
    readonly backfillConversation: (
      sessionId: SessionId,
      processId: SessionProcessId,
      turns: ReadonlyArray<BackfillTurnInput>,
    ) => Effect.Effect<number>;
    /** Crash recovery: a response caught mid-delivery reads `sending` forever; make it answerable again. */
    readonly resetSendingResponses: (processId: SessionProcessId) => Effect.Effect<void>;
    /** Relaunch fallback: move still-queued turns onto the replacement process so dispatch finds them. */
    readonly requeueQueuedTurns: (
      from: SessionProcessId,
      to: SessionProcessId,
    ) => Effect.Effect<void>;
    readonly protocolCursor: (processId: SessionProcessId) => Effect.Effect<AgentProtocolCursor>;
    readonly saveProtocolCursor: (
      processId: SessionProcessId,
      cursor: AgentProtocolCursor,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/AgentConversationRepo") {}

const toTurn = (row: typeof agentTurns.$inferSelect): AgentTurn => new AgentTurn(row);
const toItem = (row: typeof agentItems.$inferSelect): AgentItem => new AgentItem(row);
const toRequest = (row: typeof agentRequests.$inferSelect): AgentRequest => new AgentRequest(row);

export const AgentConversationRepoLive: Layer.Layer<
  AgentConversationRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  AgentConversationRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const notify = Effect.fn("AgentConversationRepo.notify")(function* (sessionId: SessionId) {
      const [row] = yield* db
        .select({ projectId: agentSessions.projectId })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1)
        .pipe(Effect.orDie);
      yield* notifyEvent(pg, {
        type: "agent-conversation",
        sessionId,
        projectId: row?.projectId ?? "",
      });
    });

    const submitTurn = Effect.fn("AgentConversationRepo.submitTurn")(function* (
      sessionId: SessionId,
      processId: SessionProcessId,
      input: string,
      author: string | null,
      launchCorrelationId: string | null = null,
    ) {
      const created = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${sessionId}`}))`,
            );
            if (launchCorrelationId !== null) {
              const [existing] = yield* tx
                .select()
                .from(agentTurns)
                .where(
                  and(
                    eq(agentTurns.sessionId, sessionId),
                    eq(agentTurns.launchCorrelationId, launchCorrelationId),
                  ),
                )
                .limit(1);
              if (existing !== undefined) {
                if (
                  existing.providerTurnId === null &&
                  (existing.processId !== processId ||
                    existing.status === "failed" ||
                    existing.status === "cancelled")
                ) {
                  const [requeued] = yield* tx
                    .update(agentTurns)
                    .set({
                      processId,
                      status: "queued",
                      error: null,
                      startedAt: null,
                      endedAt: null,
                    })
                    .where(eq(agentTurns.id, existing.id))
                    .returning();
                  if (requeued === undefined) {
                    return yield* Effect.die("agent turn requeue returned no row");
                  }
                  return toTurn(requeued);
                }
                return toTurn(existing);
              }
            }
            const [position] = yield* tx
              .select({ value: max(agentTurns.ordinal) })
              .from(agentTurns)
              .where(eq(agentTurns.sessionId, sessionId));
            const [row] = yield* tx
              .insert(agentTurns)
              .values({
                id: AgentTurnId.make(crypto.randomUUID()),
                sessionId,
                processId,
                ordinal: (position?.value ?? -1) + 1,
                author,
                input,
                launchCorrelationId,
                status: "queued",
              })
              .returning();
            if (row === undefined) return yield* Effect.die("agent turn insert returned no row");
            return toTurn(row);
          }),
        )
        .pipe(Effect.orDie);
      yield* notify(sessionId);
      return created;
    });

    const byTurnId = Effect.fn("AgentConversationRepo.byTurnId")(function* (id: AgentTurnId) {
      const [row] = yield* db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toTurn(row);
    });

    const byLaunchCorrelation = Effect.fn("AgentConversationRepo.byLaunchCorrelation")(function* (
      sessionId: SessionId,
      launchCorrelationId: string,
    ) {
      const [row] = yield* db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.sessionId, sessionId),
            eq(agentTurns.launchCorrelationId, launchCorrelationId),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toTurn(row);
    });

    const byProviderTurnId = Effect.fn("AgentConversationRepo.byProviderTurnId")(function* (
      sessionId: SessionId,
      providerTurnId: string,
    ) {
      const [row] = yield* db
        .select()
        .from(agentTurns)
        .where(
          and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.providerTurnId, providerTurnId)),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toTurn(row);
    });

    const listTurns = Effect.fn("AgentConversationRepo.listTurns")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.sessionId, sessionId))
        .orderBy(asc(agentTurns.ordinal))
        .pipe(Effect.orDie);
      return rows.map(toTurn);
    });

    const openTurns = Effect.fn("AgentConversationRepo.openTurns")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.sessionId, sessionId),
            inArray(agentTurns.status, [...OPEN_AGENT_TURN_STATUSES]),
          ),
        )
        .orderBy(asc(agentTurns.ordinal))
        .pipe(Effect.orDie);
      return rows.map(toTurn);
    });

    const claimNextTurn = Effect.fn("AgentConversationRepo.claimNextTurn")(function* (
      processId: SessionProcessId,
    ) {
      const claimed = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-process:${processId}`}))`,
            );
            const [running] = yield* tx
              .select({ id: agentTurns.id })
              .from(agentTurns)
              .where(and(eq(agentTurns.processId, processId), eq(agentTurns.status, "running")))
              .limit(1);
            if (running !== undefined) return null;
            const [queued] = yield* tx
              .select()
              .from(agentTurns)
              .where(and(eq(agentTurns.processId, processId), eq(agentTurns.status, "queued")))
              .orderBy(asc(agentTurns.ordinal))
              .limit(1)
              .for("update", { skipLocked: true });
            if (queued === undefined) return null;
            const now = new Date();
            const [row] = yield* tx
              .update(agentTurns)
              .set({ status: "running", startedAt: now })
              .where(and(eq(agentTurns.id, queued.id), eq(agentTurns.status, "queued")))
              .returning();
            return row === undefined ? null : toTurn(row);
          }),
        )
        .pipe(Effect.orDie);
      if (claimed !== null) yield* notify(claimed.sessionId);
      return claimed;
    });

    const setProviderTurnId = Effect.fn("AgentConversationRepo.setProviderTurnId")(function* (
      id: AgentTurnId,
      providerTurnId: string,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ providerTurnId })
        .where(eq(agentTurns.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AgentTurnNotFoundError({ turnId: id });
      yield* notify(row.sessionId);
      return toTurn(row);
    });

    const bindRunningProviderTurn = Effect.fn("AgentConversationRepo.bindRunningProviderTurn")(
      function* (sessionId: SessionId, processId: SessionProcessId, providerTurnId: string) {
        const existing = yield* byProviderTurnId(sessionId, providerTurnId);
        if (existing !== null) return existing;
        const [row] = yield* db
          .update(agentTurns)
          .set({ providerTurnId })
          .where(
            and(
              eq(agentTurns.sessionId, sessionId),
              eq(agentTurns.processId, processId),
              eq(agentTurns.status, "running"),
              isNull(agentTurns.providerTurnId),
            ),
          )
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return null;
        yield* notify(sessionId);
        return toTurn(row);
      },
    );

    const failTurn = Effect.fn("AgentConversationRepo.failTurn")(function* (
      id: AgentTurnId,
      error: string,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ status: "failed", error, endedAt: new Date() })
        .where(eq(agentTurns.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AgentTurnNotFoundError({ turnId: id });
      yield* notify(row.sessionId);
      return toTurn(row);
    });

    const setTurnIntent = Effect.fn("AgentConversationRepo.setTurnIntent")(function* (
      id: AgentTurnId,
      reading: RequestIntentReading,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ intent: reading.intent, intentSource: reading.source })
        .where(eq(agentTurns.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AgentTurnNotFoundError({ turnId: id });
      yield* notify(row.sessionId);
      return toTurn(row);
    });

    const claimTurnLanding = Effect.fn("AgentConversationRepo.claimTurnLanding")(function* (
      id: AgentTurnId,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ landingClaimedAt: new Date() })
        .where(
          and(
            eq(agentTurns.id, id),
            isNull(agentTurns.landingClaimedAt),
            notInArray(agentTurns.status, [...OPEN_AGENT_TURN_STATUSES]),
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toTurn(row);
    });

    const decideTurnLanding = Effect.fn("AgentConversationRepo.decideTurnLanding")(function* (
      id: AgentTurnId,
      landing: TurnLanding,
      landingId: ChangeLandingId | null,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ landing, landingId })
        .where(eq(agentTurns.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AgentTurnNotFoundError({ turnId: id });
      yield* notify(row.sessionId);
      return toTurn(row);
    });

    const completeTurn = Effect.fn("AgentConversationRepo.completeTurn")(function* (
      providerTurnId: string,
      sessionId: SessionId,
      status: Exclude<AgentTurnStatus, "queued" | "running">,
      usage: AgentTurnUsage | null,
      error: string | null,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ status, usage, error, endedAt: new Date() })
        .where(
          and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.providerTurnId, providerTurnId)),
        )
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return null;
      yield* notify(row.sessionId);
      return toTurn(row);
    });

    const upsertItem = Effect.fn("AgentConversationRepo.upsertItem")(function* (
      input: UpsertAgentItemInput,
    ) {
      const item = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${input.sessionId}`}))`,
            );
            const [existing] = yield* tx
              .select()
              .from(agentItems)
              .where(
                and(
                  eq(agentItems.processId, input.processId),
                  eq(agentItems.providerItemId, input.providerItemId),
                ),
              )
              .limit(1)
              .for("update");
            if (
              existing !== undefined &&
              existing.providerOutputProcessId === input.processId &&
              (existing.providerOutputSeq > input.providerOutputSeq ||
                (existing.providerOutputSeq === input.providerOutputSeq &&
                  existing.providerEventIndex >= input.providerEventIndex))
            ) {
              return toItem(existing);
            }
            const [position] = yield* tx
              .select({ value: max(agentItems.seq) })
              .from(agentItems)
              .where(eq(agentItems.sessionId, input.sessionId));
            const nextSequence = (position?.value ?? 0) + 1;
            if (existing !== undefined) {
              const [updated] = yield* tx
                .update(agentItems)
                .set({
                  turnId: input.turnId,
                  seq: nextSequence,
                  providerOutputProcessId: input.processId,
                  providerOutputSeq: input.providerOutputSeq,
                  providerEventIndex: input.providerEventIndex,
                  kind: input.kind,
                  status: input.status,
                  title: input.title,
                  text: input.text,
                  data: input.data,
                  updatedAt: new Date(),
                })
                .where(eq(agentItems.id, existing.id))
                .returning();
              if (updated === undefined) {
                return yield* Effect.die("agent item update returned no row");
              }
              return toItem(updated);
            }
            const [created] = yield* tx
              .insert(agentItems)
              .values({
                id: AgentItemId.make(crypto.randomUUID()),
                sessionId: input.sessionId,
                processId: input.processId,
                turnId: input.turnId,
                seq: nextSequence,
                providerItemId: input.providerItemId,
                providerOutputProcessId: input.processId,
                providerOutputSeq: input.providerOutputSeq,
                providerEventIndex: input.providerEventIndex,
                kind: input.kind,
                status: input.status,
                title: input.title,
                text: input.text,
                data: input.data,
              })
              .returning();
            if (created === undefined)
              return yield* Effect.die("agent item insert returned no row");
            return toItem(created);
          }),
        )
        .pipe(Effect.orDie);
      yield* notify(input.sessionId);
      return item;
    });

    const listItems = Effect.fn("AgentConversationRepo.listItems")(function* (
      sessionId: SessionId,
      after: number,
      limit: number,
    ) {
      const rows = yield* db
        .select()
        .from(agentItems)
        .where(and(eq(agentItems.sessionId, sessionId), gt(agentItems.seq, after)))
        .orderBy(asc(agentItems.seq))
        .limit(limit)
        .pipe(Effect.orDie);
      return rows.map(toItem);
    });

    const turnMessages = Effect.fn("AgentConversationRepo.turnMessages")(function* (
      turnId: AgentTurnId,
    ) {
      const rows = yield* db
        .select()
        .from(agentItems)
        .where(
          and(
            eq(agentItems.turnId, turnId),
            inArray(agentItems.kind, ["assistant-message", "plan"]),
          ),
        )
        .orderBy(asc(agentItems.createdAt), asc(agentItems.id))
        .pipe(Effect.orDie);
      return rows.map(toItem);
    });

    const openRequest = Effect.fn("AgentConversationRepo.openRequest")(function* (
      input: OpenAgentRequestInput,
    ) {
      const [row] = yield* db
        .insert(agentRequests)
        .values({
          id: AgentRequestId.make(crypto.randomUUID()),
          sessionId: input.sessionId,
          processId: input.processId,
          turnId: input.turnId,
          kind: input.kind,
          providerRequestId: input.providerRequestId,
          providerItemId: input.providerItemId,
          title: input.title,
          detail: input.detail,
          questions: input.questions,
        })
        .onConflictDoUpdate({
          target: [agentRequests.processId, agentRequests.providerRequestId],
          set: {
            turnId: input.turnId,
            kind: input.kind,
            providerItemId: input.providerItemId,
            title: input.title,
            detail: input.detail,
            questions: input.questions,
          },
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("agent request upsert returned no row");
      yield* notify(input.sessionId);
      return toRequest(row);
    });

    const byRequestId = Effect.fn("AgentConversationRepo.byRequestId")(function* (
      id: AgentRequestId,
    ) {
      const [row] = yield* db
        .select()
        .from(agentRequests)
        .where(eq(agentRequests.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toRequest(row);
    });

    const listRequests = Effect.fn("AgentConversationRepo.listRequests")(function* (
      sessionId: SessionId,
      pendingOnly: boolean,
    ) {
      const rows = yield* db
        .select()
        .from(agentRequests)
        .where(
          pendingOnly
            ? and(eq(agentRequests.sessionId, sessionId), eq(agentRequests.status, "pending"))
            : eq(agentRequests.sessionId, sessionId),
        )
        .orderBy(asc(agentRequests.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toRequest);
    });

    const hasPendingRequests = Effect.fn("AgentConversationRepo.hasPendingRequests")(function* (
      sessionId: SessionId,
    ) {
      const [row] = yield* db
        .select({ id: agentRequests.id })
        .from(agentRequests)
        .where(and(eq(agentRequests.sessionId, sessionId), eq(agentRequests.status, "pending")))
        .limit(1)
        .pipe(Effect.orDie);
      return row !== undefined;
    });

    const prepareRequestResponse = Effect.fn("AgentConversationRepo.prepareRequestResponse")(
      function* (id: AgentRequestId, response: ResolveAgentRequestInput, decidedBy: string) {
        const [existing] = yield* db
          .select()
          .from(agentRequests)
          .where(eq(agentRequests.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (existing === undefined) return yield* new AgentRequestNotFoundError({ requestId: id });
        if (
          existing.status !== "pending" ||
          (existing.responseDelivery !== "none" && existing.responseDelivery !== "failed")
        ) {
          return yield* new AgentRequestAlreadyResolvedError({ requestId: id });
        }
        const [row] = yield* db
          .update(agentRequests)
          .set({
            decision: "decision" in response ? response.decision : null,
            answers: "answers" in response ? response.answers : null,
            decidedBy,
            decidedAt: new Date(),
            responseDelivery: "sending",
          })
          .where(
            and(
              eq(agentRequests.id, id),
              eq(agentRequests.status, "pending"),
              sql`${agentRequests.responseDelivery} IN ('none', 'failed')`,
            ),
          )
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new AgentRequestAlreadyResolvedError({ requestId: id });
        }
        yield* notify(row.sessionId);
        return toRequest(row);
      },
    );

    const completeRequestResponse = Effect.fn("AgentConversationRepo.completeRequestResponse")(
      function* (id: AgentRequestId) {
        const [row] = yield* db
          .update(agentRequests)
          .set({ status: "resolved", responseDelivery: "delivered" })
          .where(
            and(
              eq(agentRequests.id, id),
              eq(agentRequests.status, "pending"),
              eq(agentRequests.responseDelivery, "sending"),
            ),
          )
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new AgentRequestNotFoundError({ requestId: id });
        yield* notify(row.sessionId);
        return toRequest(row);
      },
    );

    const failRequestResponse = Effect.fn("AgentConversationRepo.failRequestResponse")(function* (
      id: AgentRequestId,
    ) {
      const rows = yield* db
        .update(agentRequests)
        .set({ responseDelivery: "failed" })
        .where(and(eq(agentRequests.id, id), eq(agentRequests.responseDelivery, "sending")))
        .returning({ sessionId: agentRequests.sessionId })
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
    });

    const resolveRequest = Effect.fn("AgentConversationRepo.resolveRequest")(function* (
      id: AgentRequestId,
      response: ResolveAgentRequestInput,
      decidedBy: string,
    ) {
      yield* prepareRequestResponse(id, response, decidedBy);
      return yield* completeRequestResponse(id);
    });

    const resolveProviderRequest = Effect.fn("AgentConversationRepo.resolveProviderRequest")(
      function* (processId: SessionProcessId, providerRequestId: string) {
        const rows = yield* db
          .update(agentRequests)
          .set({ status: "resolved", decidedAt: new Date() })
          .where(
            and(
              eq(agentRequests.processId, processId),
              eq(agentRequests.providerRequestId, providerRequestId),
              eq(agentRequests.status, "pending"),
            ),
          )
          .returning({ sessionId: agentRequests.sessionId })
          .pipe(Effect.orDie);
        const first = rows[0];
        if (first !== undefined) yield* notify(first.sessionId);
      },
    );

    const cancelOpenForTurn = Effect.fn("AgentConversationRepo.cancelOpenForTurn")(function* (
      turnId: AgentTurnId,
    ) {
      const now = new Date();
      const rows = yield* db
        .update(agentRequests)
        .set({
          status: "cancelled",
          decision: sql`COALESCE(${agentRequests.decision}, 'cancel')`,
          decidedAt: sql`COALESCE(${agentRequests.decidedAt}, ${now})`,
          responseDelivery: sql`CASE WHEN ${agentRequests.responseDelivery} = 'sending' THEN 'failed' ELSE ${agentRequests.responseDelivery} END`,
        })
        .where(
          and(
            eq(agentRequests.turnId, turnId),
            eq(agentRequests.status, "pending"),
            sql`${agentRequests.responseDelivery} <> 'sending'`,
          ),
        )
        .returning({ sessionId: agentRequests.sessionId })
        .pipe(Effect.orDie);
      yield* db
        .update(agentTurns)
        .set({ status: "cancelled", endedAt: now })
        .where(and(eq(agentTurns.id, turnId), eq(agentTurns.status, "queued")))
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
    });

    const cancelOpenForProcess = Effect.fn("AgentConversationRepo.cancelOpenForProcess")(function* (
      processId: SessionProcessId,
    ) {
      const now = new Date();
      const rows = yield* db
        .update(agentRequests)
        .set({
          status: "cancelled",
          decision: sql`COALESCE(${agentRequests.decision}, 'cancel')`,
          decidedAt: sql`COALESCE(${agentRequests.decidedAt}, ${now})`,
          responseDelivery: sql`CASE WHEN ${agentRequests.responseDelivery} = 'sending' THEN 'failed' ELSE ${agentRequests.responseDelivery} END`,
        })
        .where(and(eq(agentRequests.processId, processId), eq(agentRequests.status, "pending")))
        .returning({ sessionId: agentRequests.sessionId })
        .pipe(Effect.orDie);
      yield* db
        .update(agentTurns)
        .set({ status: "cancelled", endedAt: now })
        .where(
          and(
            eq(agentTurns.processId, processId),
            sql`${agentTurns.status} IN ('queued', 'running')`,
          ),
        )
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
    });

    const backfillConversation = Effect.fn("AgentConversationRepo.backfillConversation")(function* (
      sessionId: SessionId,
      processId: SessionProcessId,
      turns: ReadonlyArray<BackfillTurnInput>,
    ) {
      if (turns.length === 0) return 0;
      const landed = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${sessionId}`}))`,
            );
            const existing = yield* tx
              .select({ providerTurnId: agentTurns.providerTurnId })
              .from(agentTurns)
              .where(eq(agentTurns.sessionId, sessionId));
            const seen = new Set(
              existing.flatMap((row) => (row.providerTurnId === null ? [] : [row.providerTurnId])),
            );
            const [turnPosition] = yield* tx
              .select({ value: max(agentTurns.ordinal) })
              .from(agentTurns)
              .where(eq(agentTurns.sessionId, sessionId));
            const [itemPosition] = yield* tx
              .select({ value: max(agentItems.seq) })
              .from(agentItems)
              .where(eq(agentItems.sessionId, sessionId));
            let ordinal = (turnPosition?.value ?? -1) + 1;
            let seq = (itemPosition?.value ?? 0) + 1;
            const now = new Date();
            let count = 0;
            for (const turn of turns) {
              if (seen.has(turn.providerTurnId)) continue;
              const [turnRow] = yield* tx
                .insert(agentTurns)
                .values({
                  id: AgentTurnId.make(crypto.randomUUID()),
                  sessionId,
                  processId,
                  ordinal: ordinal++,
                  author: null,
                  input: turn.input,
                  status: "completed",
                  providerTurnId: turn.providerTurnId,
                  startedAt: now,
                  endedAt: now,
                })
                .returning();
              if (turnRow === undefined) {
                return yield* Effect.die("agent turn backfill returned no row");
              }
              let eventIndex = 0;
              for (const item of turn.items) {
                yield* tx
                  .insert(agentItems)
                  .values({
                    id: AgentItemId.make(crypto.randomUUID()),
                    sessionId,
                    processId,
                    turnId: turnRow.id,
                    seq: seq++,
                    providerItemId: item.providerItemId,
                    providerOutputProcessId: processId,
                    providerOutputSeq: 0n,
                    providerEventIndex: eventIndex++,
                    kind: item.kind,
                    status: item.status,
                    title: item.title,
                    text: item.text,
                    data: item.data,
                  })
                  .onConflictDoNothing();
              }
              count += 1;
            }
            return count;
          }),
        )
        .pipe(Effect.orDie);
      if (landed > 0) yield* notify(sessionId);
      return landed;
    });

    const resetSendingResponses = Effect.fn("AgentConversationRepo.resetSendingResponses")(
      function* (processId: SessionProcessId) {
        const rows = yield* db
          .update(agentRequests)
          .set({ responseDelivery: "failed" })
          .where(
            and(
              eq(agentRequests.processId, processId),
              eq(agentRequests.status, "pending"),
              eq(agentRequests.responseDelivery, "sending"),
            ),
          )
          .returning({ sessionId: agentRequests.sessionId })
          .pipe(Effect.orDie);
        const first = rows[0];
        if (first !== undefined) yield* notify(first.sessionId);
      },
    );

    const requeueQueuedTurns = Effect.fn("AgentConversationRepo.requeueQueuedTurns")(function* (
      from: SessionProcessId,
      to: SessionProcessId,
    ) {
      const rows = yield* db
        .update(agentTurns)
        .set({ processId: to })
        .where(and(eq(agentTurns.processId, from), eq(agentTurns.status, "queued")))
        .returning({ sessionId: agentTurns.sessionId })
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
    });

    const protocolCursor = Effect.fn("AgentConversationRepo.protocolCursor")(function* (
      processId: SessionProcessId,
    ) {
      const [row] = yield* db
        .select({
          nextSequence: sessionProcesses.protocolOutputSeq,
        })
        .from(sessionProcesses)
        .where(eq(sessionProcesses.id, processId))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? { nextSequence: 0n };
    });

    const saveProtocolCursor = Effect.fn("AgentConversationRepo.saveProtocolCursor")(function* (
      processId: SessionProcessId,
      cursor: AgentProtocolCursor,
    ) {
      yield* db
        .update(sessionProcesses)
        .set({
          protocolOutputSeq: cursor.nextSequence,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sessionProcesses.id, processId),
            isNull(sessionProcesses.exitedAt),
            sql`${sessionProcesses.protocolOutputSeq} <= ${cursor.nextSequence}`,
          ),
        )
        .pipe(Effect.orDie);
    });

    return {
      submitTurn,
      byTurnId,
      byLaunchCorrelation,
      byProviderTurnId,
      listTurns,
      openTurns,
      claimNextTurn,
      setProviderTurnId,
      bindRunningProviderTurn,
      failTurn,
      setTurnIntent,
      claimTurnLanding,
      decideTurnLanding,
      completeTurn,
      upsertItem,
      listItems,
      turnMessages,
      openRequest,
      byRequestId,
      listRequests,
      hasPendingRequests,
      prepareRequestResponse,
      completeRequestResponse,
      failRequestResponse,
      resolveRequest,
      resolveProviderRequest,
      cancelOpenForTurn,
      cancelOpenForProcess,
      backfillConversation,
      resetSendingResponses,
      requeueQueuedTurns,
      protocolCursor,
      saveProtocolCursor,
    };
  }),
);
