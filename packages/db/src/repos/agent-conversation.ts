import { PgClient } from "@effect/sql-pg";
import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  AgentTurnSteerId,
  type ChangeLandingId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  AgentItem,
  AgentRequest,
  AgentTurn,
  AgentTurnSteer,
  AgentTurnSteerDelivery,
  AgentProtocolControl,
  ConversationTurn,
  turnSteerSender,
  type TurnSteerQueueReason,
  OPEN_AGENT_TURN_STATUSES,
  type AgentApprovalDecision,
  type AgentEventItem,
  type AgentEventRequest,
  type AgentInputAnswers,
  type AgentTurnStatus,
  type AgentTurnUsage,
  type RequestIntentReading,
  type TurnLanding,
  type TurnPayer,
} from "@mend/domain/workbench";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentItems,
  agentRequests,
  agentSessions,
  agentTurns,
  agentTurnSteers,
  agentProtocolControlJournal,
  sessionProcesses,
} from "../schema/workbench.ts";
import { pageItemRow, pagesWithoutItems, publishedPageIdOf } from "./page-items.ts";

/** A requested protocol turn does not exist. */
export class AgentTurnNotFoundError extends Schema.TaggedError<AgentTurnNotFoundError>()(
  "AgentTurnNotFoundError",
  { turnId: Schema.String },
) {}

/**
 * A turn asked of a session whose idle stop has begun (`SessionsRepo.claimIdleStop`): the agent is
 * being stopped, so nothing is queued for it. The next message resumes the session instead.
 */
export class SessionStoppingError extends Schema.TaggedError<SessionStoppingError>()(
  "SessionStoppingError",
  { sessionId: Schema.String },
) {}

export const lockAgentConversation = (tx: Pick<MendDatabase, "execute">, sessionId: SessionId) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${sessionId}`}))`,
  );

const steerKeyLockKey = (author: string, clientSteerId: string): string =>
  `mend:steer:${author}:${clientSteerId}`;

/** A requested agent-to-human request does not exist. */
export class AgentRequestNotFoundError extends Schema.TaggedError<AgentRequestNotFoundError>()(
  "AgentRequestNotFoundError",
  { requestId: Schema.String },
) {}

/** A request already has a recorded answer or cancellation. */
export class AgentRequestAlreadyResolvedError extends Schema.TaggedError<AgentRequestAlreadyResolvedError>()(
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
export interface AgentTaskActivity {
  readonly running: number;
  readonly lastUpdatedAt: Date | null;
}

export interface AgentProtocolCursor {
  readonly nextSequence: bigint;
}

/** Approval or structured-input response recorded for one request. */
export type ResolveAgentRequestInput =
  | { readonly decision: AgentApprovalDecision; readonly answers?: never }
  | { readonly answers: AgentInputAnswers; readonly decision?: never };

export interface AdmitTurnSteerInput {
  readonly turnId: AgentTurnId;
  readonly author: string;
  readonly input: string;
  readonly clientSteerId: string | null;
}

export class AgentControlJournalError extends Schema.TaggedError<AgentControlJournalError>()(
  "AgentControlJournalError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

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
    ) => Effect.Effect<AgentTurn, SessionStoppingError>;
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
    readonly listConversationTurns: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<ConversationTurn>>;
    readonly admitTurnSteer: (
      input: AdmitTurnSteerInput,
    ) => Effect.Effect<
      { readonly steer: AgentTurnSteer; readonly created: boolean },
      AgentTurnNotFoundError
    >;
    readonly steerByClientId: (
      author: string,
      clientSteerId: string,
    ) => Effect.Effect<AgentTurnSteer | null>;
    readonly settleTurnSteer: (
      id: AgentTurnSteerId,
      delivery: Exclude<AgentTurnSteerDelivery, { readonly _tag: "Sending" | "Queued" }>,
    ) => Effect.Effect<AgentTurnSteer>;
    readonly queueTurnSteer: (
      id: AgentTurnSteerId,
      processId: SessionProcessId | null,
      reason: TurnSteerQueueReason,
    ) => Effect.Effect<AgentTurnSteer>;
    /**
     * A Queued steer whose turn no process will take (its process detached as the turn was
     * queued): the turn is cancelled and the words stay, NotSent. A turn another process took
     * meanwhile keeps the receipt.
     */
    readonly withdrawTurnSteer: (id: AgentTurnSteerId) => Effect.Effect<AgentTurnSteer>;
    /** A restart ends the process's steers left Sending as Unknown: they are never re-sent. */
    readonly recoverSendingSteers: (processId: SessionProcessId) => Effect.Effect<void>;
    readonly recordProtocolControl: (
      processId: SessionProcessId,
      control: AgentProtocolControl,
    ) => Effect.Effect<void, AgentControlJournalError>;
    readonly protocolControls: (
      processId: SessionProcessId,
    ) => Effect.Effect<ReadonlyArray<AgentProtocolControl>>;
    /** Every queued or running turn, oldest first. */
    readonly openTurns: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<AgentTurn>>;
    readonly claimNextTurn: (processId: SessionProcessId) => Effect.Effect<AgentTurn | null>;
    /**
     * Record a turn the harness opened on its own, running. A turn of Mend's the process claimed
     * but never sent goes back to the queue: the harness holds the conversation until its turn
     * ends. Idempotent by provider turn id; null when another sent turn still runs.
     */
    readonly openHarnessTurn: (
      sessionId: SessionId,
      processId: SessionProcessId,
      providerTurnId: string,
      reason: string,
      /** Whose login the workspace held when the harness opened it. */
      payer: TurnPayer,
    ) => Effect.Effect<AgentTurn | null>;
    /** Put back a claimed turn the harness would not take yet (it was busy in its own turn). */
    readonly requeueClaimedTurn: (id: AgentTurnId) => Effect.Effect<void>;
    readonly setProviderTurnId: (
      id: AgentTurnId,
      providerTurnId: string,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    /**
     * Record whose login a sent turn ran on (docs/adr/0013, "Every turn records its payer"),
     * replacing what a previous send of the same turn recorded.
     */
    readonly setTurnPayer: (
      id: AgentTurnId,
      payer: TurnPayer,
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
    /** Everything the agent said and did in one turn, in conversation order. */
    readonly turnItems: (turnId: AgentTurnId) => Effect.Effect<ReadonlyArray<AgentItem>>;
    readonly openRequest: (input: OpenAgentRequestInput) => Effect.Effect<AgentRequest>;
    readonly byRequestId: (id: AgentRequestId) => Effect.Effect<AgentRequest | null>;
    readonly listRequests: (
      sessionId: SessionId,
      pendingOnly: boolean,
    ) => Effect.Effect<ReadonlyArray<AgentRequest>>;
    readonly hasPendingRequests: (sessionId: SessionId) => Effect.Effect<boolean>;
    /**
     * The background tasks one agent process reported (`task` items): how many still run, and
     * when any last changed.
     */
    readonly taskActivity: (processId: SessionProcessId) => Effect.Effect<AgentTaskActivity>;
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
     * Mode switch: land PTY-era turns from the native transcript as completed
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

const toSteer = (row: typeof agentTurnSteers.$inferSelect): AgentTurnSteer =>
  new AgentTurnSteer({
    ...row,
    delivery: Schema.decodeUnknownSync(AgentTurnSteerDelivery)(row.delivery),
  });

const toTurn = (row: typeof agentTurns.$inferSelect): AgentTurn => new AgentTurn(row);
const toItem = (row: typeof agentItems.$inferSelect): AgentItem => new AgentItem(row);
const toRequest = (row: typeof agentRequests.$inferSelect): AgentRequest => new AgentRequest(row);

export const nextAgentItemSeq = Effect.fn("AgentConversationRepo.nextAgentItemSeq")(function* (
  tx: Pick<MendDatabase, "select">,
  sessionId: SessionId,
) {
  const [position] = yield* tx
    .select({ value: max(agentItems.seq) })
    .from(agentItems)
    .where(eq(agentItems.sessionId, sessionId));
  return (position?.value ?? 0) + 1;
});

export const notifyAgentConversation = Effect.fn("AgentConversationRepo.notify")(function* (
  db: Pick<MendDatabase, "select">,
  pg: PgClient.PgClient,
  sessionId: SessionId,
) {
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

type ConversationTx = Pick<MendDatabase, "select" | "insert" | "execute">;

const lockOpenConversation = Effect.fn("AgentConversationRepo.lockOpenConversation")(function* (
  tx: ConversationTx,
  sessionId: SessionId,
) {
  yield* lockAgentConversation(tx, sessionId);
  const [stopping] = yield* tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        or(isNotNull(agentSessions.idleStoppedAt), isNotNull(agentSessions.settledAt)),
      ),
    );
  return stopping === undefined;
});

const insertQueuedTurn = Effect.fn("AgentConversationRepo.insertQueuedTurn")(function* (
  tx: ConversationTx,
  turn: {
    readonly sessionId: SessionId;
    readonly processId: SessionProcessId;
    readonly input: string;
    readonly author: string | null;
    readonly launchCorrelationId: string | null;
  },
) {
  const [position] = yield* tx
    .select({ value: max(agentTurns.ordinal) })
    .from(agentTurns)
    .where(eq(agentTurns.sessionId, turn.sessionId));
  const [row] = yield* tx
    .insert(agentTurns)
    .values({
      ...turn,
      id: AgentTurnId.make(crypto.randomUUID()),
      ordinal: (position?.value ?? -1) + 1,
      status: "queued",
    })
    .returning();
  if (row === undefined) return yield* Effect.die("agent turn insert returned no row");
  return toTurn(row);
});

/** Cancel queued turns and their open requests in the caller's transaction, without events. */
export const cancelOpenTurnRows = Effect.fn("AgentConversationRepo.cancelOpenTurnRows")(function* (
  db: Pick<MendDatabase, "update">,
  turnIds: ReadonlyArray<AgentTurnId>,
) {
  if (turnIds.length === 0) return [];
  const now = yield* DateTime.nowAsDate;
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
        inArray(agentRequests.turnId, [...turnIds]),
        eq(agentRequests.status, "pending"),
        sql`${agentRequests.responseDelivery} <> 'sending'`,
      ),
    )
    .returning({ sessionId: agentRequests.sessionId })
    .pipe(Effect.orDie);
  yield* db
    .update(agentTurns)
    .set({ status: "cancelled", endedAt: now })
    .where(and(inArray(agentTurns.id, [...turnIds]), eq(agentTurns.status, "queued")))
    .pipe(Effect.orDie);
  return rows;
});

export const AgentConversationRepoLive: Layer.Layer<
  AgentConversationRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  AgentConversationRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const notify = (sessionId: SessionId) => notifyAgentConversation(db, pg, sessionId);

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
            if (!(yield* lockOpenConversation(tx, sessionId))) {
              return { _tag: "stopping" } as const;
            }
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
            return yield* insertQueuedTurn(tx, {
              sessionId,
              processId,
              input,
              author,
              launchCorrelationId,
            });
          }),
        )
        .pipe(Effect.orDie);
      if (!(created instanceof AgentTurn)) return yield* new SessionStoppingError({ sessionId });
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

    const listConversationTurns = Effect.fn("AgentConversationRepo.listConversationTurns")(
      function* (sessionId: SessionId) {
        const rows = yield* db
          .select({ turn: agentTurns, steer: agentTurnSteers })
          .from(agentTurns)
          .leftJoin(agentTurnSteers, eq(agentTurnSteers.turnId, agentTurns.id))
          .where(eq(agentTurns.sessionId, sessionId))
          .orderBy(asc(agentTurns.ordinal), asc(agentTurnSteers.ordinal))
          .pipe(Effect.orDie);
        const grouped = new Map<
          AgentTurnId,
          { turn: typeof agentTurns.$inferSelect; steers: Array<AgentTurnSteer> }
        >();
        const origins = new Map<AgentTurnId, AgentTurnSteerId>();
        for (const row of rows) {
          const entry = grouped.get(row.turn.id) ?? { turn: row.turn, steers: [] };
          if (row.steer !== null) {
            const steer = toSteer(row.steer);
            entry.steers.push(steer);
            if (steer.queuedTurnId !== null) origins.set(steer.queuedTurnId, steer.id);
          }
          grouped.set(row.turn.id, entry);
        }
        return [...grouped.values()].map(
          ({ turn, steers }) =>
            new ConversationTurn({
              ...turn,
              steerSender: turnSteerSender(turn),
              steers,
              fromSteer: origins.get(turn.id) ?? null,
            }),
        );
      },
    );

    const steerByClientId = Effect.fn("AgentConversationRepo.steerByClientId")(function* (
      author: string,
      clientSteerId: string,
    ) {
      const [row] = yield* db
        .select()
        .from(agentTurnSteers)
        .where(
          and(eq(agentTurnSteers.author, author), eq(agentTurnSteers.clientSteerId, clientSteerId)),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toSteer(row);
    });

    const admitTurnSteer = Effect.fn("AgentConversationRepo.admitTurnSteer")(function* (
      input: AdmitTurnSteerInput,
    ) {
      const clientSteerId = input.clientSteerId?.toLowerCase() ?? null;
      const turn = yield* byTurnId(input.turnId);
      if (turn === null) return yield* new AgentTurnNotFoundError({ turnId: input.turnId });
      const admitted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (clientSteerId !== null) {
              yield* tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${steerKeyLockKey(input.author, clientSteerId)}))`,
              );
              const [existing] = yield* tx
                .select()
                .from(agentTurnSteers)
                .where(
                  and(
                    eq(agentTurnSteers.author, input.author),
                    eq(agentTurnSteers.clientSteerId, clientSteerId),
                  ),
                )
                .limit(1);
              if (existing !== undefined) return { steer: toSteer(existing), created: false };
            }
            yield* lockAgentConversation(tx, turn.sessionId);
            const [target] = yield* tx
              .select()
              .from(agentTurns)
              .where(eq(agentTurns.id, turn.id))
              .for("update");
            if (target === undefined) return null;
            const [position] = yield* tx
              .select({ value: max(agentTurnSteers.ordinal) })
              .from(agentTurnSteers)
              .where(eq(agentTurnSteers.turnId, turn.id));
            const [row] = yield* tx
              .insert(agentTurnSteers)
              .values({
                id: AgentTurnSteerId.make(crypto.randomUUID()),
                sessionId: target.sessionId,
                processId: target.processId,
                turnId: target.id,
                author: input.author,
                ordinal: (position?.value ?? -1) + 1,
                input: input.input,
                delivery: { _tag: "Sending" },
                clientSteerId,
              })
              .returning();
            if (row === undefined) return yield* Effect.die("steer insert returned no row");
            return { steer: toSteer(row), created: true };
          }),
        )
        .pipe(Effect.orDie);
      if (admitted === null) return yield* new AgentTurnNotFoundError({ turnId: input.turnId });
      if (admitted.created) yield* notify(admitted.steer.sessionId);
      return admitted;
    });

    const settleTurnSteer = Effect.fn("AgentConversationRepo.settleTurnSteer")(function* (
      id: AgentTurnSteerId,
      delivery: Exclude<AgentTurnSteerDelivery, { readonly _tag: "Sending" | "Queued" }>,
    ) {
      const [changed] = yield* db
        .update(agentTurnSteers)
        .set({ delivery, updatedAt: yield* DateTime.nowAsDate })
        .where(
          and(eq(agentTurnSteers.id, id), sql`${agentTurnSteers.delivery}->>'_tag' = 'Sending'`),
        )
        .returning()
        .pipe(Effect.orDie);
      if (changed !== undefined) {
        yield* notify(changed.sessionId);
        return toSteer(changed);
      }
      const [row] = yield* db
        .select()
        .from(agentTurnSteers)
        .where(eq(agentTurnSteers.id, id))
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("steer disappeared");
      return toSteer(row);
    });

    const queueTurnSteer = Effect.fn("AgentConversationRepo.queueTurnSteer")(function* (
      id: AgentTurnSteerId,
      processId: SessionProcessId | null,
      reason: TurnSteerQueueReason,
    ) {
      const [saved] = yield* db
        .select()
        .from(agentTurnSteers)
        .where(eq(agentTurnSteers.id, id))
        .pipe(Effect.orDie);
      if (saved === undefined) return yield* Effect.die("steer disappeared");
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const takesTurns = yield* lockOpenConversation(tx, saved.sessionId);
            const [row] = yield* tx
              .select()
              .from(agentTurnSteers)
              .where(eq(agentTurnSteers.id, id))
              .for("update");
            if (row === undefined) return yield* Effect.die("steer disappeared");
            if (row.delivery._tag !== "Sending") return { steer: toSteer(row), changed: false };
            const queued =
              processId === null || !takesTurns
                ? null
                : yield* insertQueuedTurn(tx, {
                    sessionId: row.sessionId,
                    processId,
                    input: row.input,
                    author: row.author,
                    launchCorrelationId: `steer:${id}`,
                  });
            const delivery: AgentTurnSteerDelivery =
              queued === null
                ? { _tag: "NotSent", reason }
                : { _tag: "Queued", turnId: queued.id, reason };
            const [changed] = yield* tx
              .update(agentTurnSteers)
              .set({
                delivery,
                queuedTurnId: queued?.id ?? null,
                updatedAt: yield* DateTime.nowAsDate,
              })
              .where(
                and(
                  eq(agentTurnSteers.id, id),
                  sql`${agentTurnSteers.delivery}->>'_tag' = 'Sending'`,
                ),
              )
              .returning();
            if (changed === undefined) return yield* Effect.die("locked steer disappeared");
            return { steer: toSteer(changed), changed: true };
          }),
        )
        .pipe(Effect.orDie);
      if (result.changed) yield* notify(result.steer.sessionId);
      return result.steer;
    });

    const withdrawTurnSteer = Effect.fn("AgentConversationRepo.withdrawTurnSteer")(function* (
      id: AgentTurnSteerId,
    ) {
      const [saved] = yield* db
        .select()
        .from(agentTurnSteers)
        .where(eq(agentTurnSteers.id, id))
        .pipe(Effect.orDie);
      if (saved === undefined) return yield* Effect.die("steer disappeared");
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockOpenConversation(tx, saved.sessionId);
            const [row] = yield* tx
              .select()
              .from(agentTurnSteers)
              .where(eq(agentTurnSteers.id, id))
              .for("update");
            if (row === undefined) return yield* Effect.die("steer disappeared");
            const delivery = row.delivery;
            if (delivery._tag !== "Queued") return { steer: toSteer(row), changed: false };
            const [turn] = yield* tx
              .select({ status: agentTurns.status })
              .from(agentTurns)
              .where(eq(agentTurns.id, delivery.turnId));
            if (turn?.status !== "queued") return { steer: toSteer(row), changed: false };
            yield* cancelOpenTurnRows(tx, [delivery.turnId]);
            const [changed] = yield* tx
              .update(agentTurnSteers)
              .set({
                delivery: { _tag: "NotSent", reason: delivery.reason },
                queuedTurnId: null,
                updatedAt: yield* DateTime.nowAsDate,
              })
              .where(eq(agentTurnSteers.id, id))
              .returning();
            if (changed === undefined) return yield* Effect.die("locked steer disappeared");
            return { steer: toSteer(changed), changed: true };
          }),
        )
        .pipe(Effect.orDie);
      if (result.changed) yield* notify(result.steer.sessionId);
      return result.steer;
    });

    const recoverSendingSteers = Effect.fn("AgentConversationRepo.recoverSendingSteers")(function* (
      processId: SessionProcessId,
    ) {
      const rows = yield* db
        .update(agentTurnSteers)
        .set({
          delivery: { _tag: "Unknown", reason: "restart" },
          updatedAt: yield* DateTime.nowAsDate,
        })
        .where(
          and(
            sql`${agentTurnSteers.delivery}->>'_tag' = 'Sending'`,
            eq(agentTurnSteers.processId, processId),
          ),
        )
        .returning({ sessionId: agentTurnSteers.sessionId })
        .pipe(Effect.orDie);
      for (const sessionId of new Set(rows.map((row) => row.sessionId))) yield* notify(sessionId);
    });

    const claimControlSlot = (processId: SessionProcessId, control: AgentProtocolControl) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(agentProtocolControlJournal)
            .values({ processId, ...control })
            .onConflictDoNothing();
          const [stored] = yield* tx
            .select()
            .from(agentProtocolControlJournal)
            .where(
              and(
                eq(agentProtocolControlJournal.processId, processId),
                eq(agentProtocolControlJournal.ordinal, control.ordinal),
              ),
            );
          return stored ?? null;
        }),
      );

    const recordProtocolControl = Effect.fn("AgentConversationRepo.recordProtocolControl")(
      function* (processId: SessionProcessId, control: AgentProtocolControl) {
        const holds = (stored: typeof agentProtocolControlJournal.$inferSelect | null) =>
          stored !== null &&
          stored.controlId === control.controlId &&
          stored.providerTurnId === control.providerTurnId &&
          stored.afterOutputLine === control.afterOutputLine &&
          stored.action === control.action;
        const claimed = yield* claimControlSlot(processId, control).pipe(Effect.result);
        if (claimed._tag === "Success") {
          if (holds(claimed.success)) return;
          return yield* new AgentControlJournalError({
            message: "The agent control conflicts with its recorded position.",
            cause: null,
          });
        }
        // A failed commit may still have landed. A `not-written` claim on the same slot settles
        // it: it finds the control (written) or takes the slot, so the control can never land.
        const settled = yield* claimControlSlot(processId, {
          ...control,
          action: "not-written",
        }).pipe(Effect.orDie);
        if (holds(settled)) return;
        return yield* new AgentControlJournalError({
          message: "The agent control could not be recorded.",
          cause: claimed.failure,
        });
      },
    );

    const protocolControls = Effect.fn("AgentConversationRepo.protocolControls")(function* (
      processId: SessionProcessId,
    ) {
      const rows = yield* db
        .select()
        .from(agentProtocolControlJournal)
        .where(eq(agentProtocolControlJournal.processId, processId))
        .orderBy(asc(agentProtocolControlJournal.ordinal))
        .pipe(Effect.orDie);
      return rows.map((row) => Schema.decodeUnknownSync(AgentProtocolControl)(row));
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
            const now = yield* DateTime.nowAsDate;
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

    const openHarnessTurn = Effect.fn("AgentConversationRepo.openHarnessTurn")(function* (
      sessionId: SessionId,
      processId: SessionProcessId,
      providerTurnId: string,
      reason: string,
      payer: TurnPayer,
    ) {
      const opened = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // The conversation lock orders the ordinal against submitTurn; the process lock
            // orders the running turn against claimNextTurn.
            yield* lockAgentConversation(tx, sessionId);
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-process:${processId}`}))`,
            );
            const [existing] = yield* tx
              .select()
              .from(agentTurns)
              .where(
                and(
                  eq(agentTurns.sessionId, sessionId),
                  eq(agentTurns.providerTurnId, providerTurnId),
                ),
              )
              .limit(1);
            if (existing !== undefined) return { turn: toTurn(existing), created: false };
            // Claimed but never sent: the adapter refuses a send while the harness's turn is open.
            yield* tx
              .update(agentTurns)
              .set({ status: "queued", startedAt: null })
              .where(
                and(
                  eq(agentTurns.processId, processId),
                  eq(agentTurns.status, "running"),
                  isNull(agentTurns.providerTurnId),
                ),
              );
            const [running] = yield* tx
              .select({ id: agentTurns.id })
              .from(agentTurns)
              .where(and(eq(agentTurns.processId, processId), eq(agentTurns.status, "running")))
              .limit(1);
            if (running !== undefined) return null;
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
                author: null,
                origin: "harness",
                input: reason,
                status: "running",
                providerTurnId,
                billedUserId: payer.userId,
                billedAccountId: payer.accountId,
                billedAccountName: payer.accountName,
                startedAt: yield* DateTime.nowAsDate,
              })
              .returning();
            if (row === undefined) return yield* Effect.die("harness turn insert returned no row");
            return { turn: toTurn(row), created: true };
          }),
        )
        .pipe(Effect.orDie);
      if (opened === null) return null;
      if (opened.created) yield* notify(sessionId);
      return opened.turn;
    });

    const taskActivity = Effect.fn("AgentConversationRepo.taskActivity")(function* (
      processId: SessionProcessId,
    ) {
      const [row] = yield* db
        .select({
          running: sql<number>`(count(*) FILTER (WHERE ${agentItems.status} = 'in-progress'))::int`,
          lastUpdatedAt: max(agentItems.updatedAt),
        })
        .from(agentItems)
        .where(and(eq(agentItems.processId, processId), eq(agentItems.kind, "task")))
        .pipe(Effect.orDie);
      return { running: row?.running ?? 0, lastUpdatedAt: row?.lastUpdatedAt ?? null };
    });

    const requeueClaimedTurn = Effect.fn("AgentConversationRepo.requeueClaimedTurn")(function* (
      id: AgentTurnId,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ status: "queued", startedAt: null })
        .where(
          and(
            eq(agentTurns.id, id),
            eq(agentTurns.status, "running"),
            isNull(agentTurns.providerTurnId),
          ),
        )
        .returning({ sessionId: agentTurns.sessionId })
        .pipe(Effect.orDie);
      if (row !== undefined) yield* notify(row.sessionId);
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

    const setTurnPayer = Effect.fn("AgentConversationRepo.setTurnPayer")(function* (
      id: AgentTurnId,
      payer: TurnPayer,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({
          billedUserId: payer.userId,
          billedAccountId: payer.accountId,
          billedAccountName: payer.accountName,
        })
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
        .set({ status: "failed", error, endedAt: yield* DateTime.nowAsDate })
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
        .set({ landingClaimedAt: yield* DateTime.nowAsDate })
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
        .set({ status, usage, error, endedAt: yield* DateTime.nowAsDate })
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
            yield* lockAgentConversation(tx, input.sessionId);
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
            const nextSequence = yield* nextAgentItemSeq(tx, input.sessionId);
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
                  updatedAt: yield* DateTime.nowAsDate,
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

    const turnItems = Effect.fn("AgentConversationRepo.turnItems")(function* (turnId: AgentTurnId) {
      const rows = yield* db
        .select()
        .from(agentItems)
        .where(eq(agentItems.turnId, turnId))
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
            decidedAt: yield* DateTime.nowAsDate,
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
          .set({ status: "resolved", decidedAt: yield* DateTime.nowAsDate })
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
      const rows = yield* cancelOpenTurnRows(db, [turnId]);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
    });

    /**
     * A process that ended took its background tasks with it: any it never reported ending read
     * `stopped`, each at a fresh cursor so readers see the change. The session id, when any did.
     */
    const stopTasksOf = Effect.fn("AgentConversationRepo.stopTasksOf")(function* (
      processId: SessionProcessId,
    ) {
      const [first] = yield* db
        .select({ sessionId: agentItems.sessionId })
        .from(agentItems)
        .where(
          and(
            eq(agentItems.processId, processId),
            eq(agentItems.kind, "task"),
            eq(agentItems.status, "in-progress"),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      if (first === undefined) return null;
      const sessionId = first.sessionId;
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentConversation(tx, sessionId);
            const running = yield* tx
              .select({ id: agentItems.id })
              .from(agentItems)
              .where(
                and(
                  eq(agentItems.processId, processId),
                  eq(agentItems.kind, "task"),
                  eq(agentItems.status, "in-progress"),
                ),
              )
              .orderBy(asc(agentItems.seq));
            let seq = yield* nextAgentItemSeq(tx, sessionId);
            const now = yield* DateTime.nowAsDate;
            for (const task of running) {
              yield* tx
                .update(agentItems)
                .set({
                  seq: seq++,
                  status: "completed",
                  data: sql`jsonb_set(${agentItems.data}, '{status}', '"stopped"')`,
                  updatedAt: now,
                })
                .where(eq(agentItems.id, task.id));
            }
          }),
        )
        .pipe(Effect.orDie);
      return sessionId;
    });

    const cancelOpenForProcess = Effect.fn("AgentConversationRepo.cancelOpenForProcess")(function* (
      processId: SessionProcessId,
    ) {
      const now = yield* DateTime.nowAsDate;
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
      const stoppedTasks = yield* stopTasksOf(processId);
      const sessionId = rows[0]?.sessionId ?? stoppedTasks;
      if (sessionId !== null) yield* notify(sessionId);
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
            yield* lockAgentConversation(tx, sessionId);
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
            let ordinal = (turnPosition?.value ?? -1) + 1;
            let seq = yield* nextAgentItemSeq(tx, sessionId);
            const now = yield* DateTime.nowAsDate;
            const unshown = yield* pagesWithoutItems(
              tx,
              sessionId,
              turns
                .filter((turn) => !seen.has(turn.providerTurnId))
                .flatMap((turn) =>
                  turn.items.flatMap((item) => publishedPageIdOf(item.data) ?? []),
                ),
            );
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
                const page = unshown.get(publishedPageIdOf(item.data) ?? "");
                if (page === undefined) continue;
                unshown.delete(page.id);
                yield* tx.insert(agentItems).values(
                  pageItemRow(page, {
                    processId,
                    turnId: turnRow.id,
                    seq: seq++,
                    eventIndex: eventIndex++,
                  }),
                );
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
          updatedAt: yield* DateTime.nowAsDate,
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
      listConversationTurns,
      admitTurnSteer,
      steerByClientId,
      settleTurnSteer,
      queueTurnSteer,
      withdrawTurnSteer,
      recoverSendingSteers,
      recordProtocolControl,
      protocolControls,
      openTurns,
      claimNextTurn,
      openHarnessTurn,
      requeueClaimedTurn,
      taskActivity,
      setProviderTurnId,
      setTurnPayer,
      bindRunningProviderTurn,
      failTurn,
      setTurnIntent,
      claimTurnLanding,
      decideTurnLanding,
      completeTurn,
      upsertItem,
      listItems,
      turnMessages,
      turnItems,
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
