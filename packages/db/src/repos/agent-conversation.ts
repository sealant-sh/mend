import { PgClient } from "@effect/sql-pg";
import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  AgentTurnSteerId,
  SessionMessageId,
  type ChangeLandingId,
  type ClientMessageId,
  type DispatchAttemptId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import {
  HistoryAdmissionRefusedError,
  MergeBackContext,
  type HistoryPosition,
  TurnSelection,
  turnSelectionOf,
  selectionMatches,
} from "@mend/domain/workbench";
import {
  MessageKeyConflictError,
  TurnSteerForbiddenError,
  messageOutcome,
  type MessageTurnReason,
  type SendMessageInput,
  type SessionMessageResult,
  AgentItem,
  AgentRequest,
  AgentTurn,
  importedTurnProcessIdOf,
  waitingTurnProcessIdOf,
  AgentTurnSteer,
  AgentTurnSteerDelivery,
  AgentProtocolControl,
  ConversationSteer,
  ConversationTurn,
  turnSteerSender,
  type TurnSteerQueueReason,
  OPEN_AGENT_TURN_STATUSES,
  TURN_DELIVERY_UNCONFIRMED,
  type AgentApprovalDecision,
  type AgentEventItem,
  type AgentEventRequest,
  type AgentInputAnswers,
  type AgentItemKind,
  type AgentTurnStatus,
  type AgentTurnUsage,
  MemoryLimitHit,
  type UnreachableCause,
  type RequestIntentReading,
  type TurnLanding,
  type TurnPayer,
} from "@mend/domain/workbench";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  isNotNull,
  isNull,
  max,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Cause, DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  worktrees,
  sessionMessages,
  agentItems,
  agentRequests,
  agentSessions,
  agentTurns,
  agentTurnSteers,
  agentProtocolControlJournal,
  previewPreparations,
  sessionProcesses,
  sessionMergeBacks,
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

/** Every conversation/process writer takes its worktree lock before narrower locks. */
export const lockAgentConversation = (tx: Pick<MendDatabase, "execute">, sessionId: SessionId) =>
  Effect.gen(function* () {
    yield* tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('mend:history-worktree:' || worktree_id)) FROM agent_sessions WHERE id=${sessionId}`,
    );
    yield* tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-conversation:${sessionId}`}))`,
    );
  });

/** A process claim never takes the shared worktree lock after its process lock. */
const lockAgentProcess = (tx: Pick<MendDatabase, "execute">, processId: SessionProcessId) =>
  Effect.gen(function* () {
    yield* tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('mend:history-worktree:' || s.worktree_id)) FROM session_processes p JOIN agent_sessions s ON s.id=p.session_id WHERE p.id=${processId}`,
    );
    yield* tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:agent-process:${processId}`}))`,
    );
  });

const historyAdmission = (tx: Pick<MendDatabase, "select">, sessionId: SessionId) =>
  tx
    .select({
      historyRevision: agentSessions.historyRevision,
      worktreeEpoch: worktrees.historyEpoch,
      fence: worktrees.historyOperationId,
    })
    .from(agentSessions)
    .innerJoin(worktrees, eq(worktrees.id, agentSessions.worktreeId))
    .where(eq(agentSessions.id, sessionId));

const assertHistoryAdmission = Effect.fn("AgentConversationRepo.assertHistoryAdmission")(function* (
  tx: Pick<MendDatabase, "select">,
  sessionId: SessionId,
  expected?: HistoryPosition,
) {
  const [position] = yield* historyAdmission(tx, sessionId);
  if (position?.fence !== null && position?.fence !== undefined)
    return yield* new HistoryAdmissionRefusedError({
      sessionId,
      reason: "history_operation_in_progress",
      message:
        "A history operation is in progress for this worktree. Your message was not admitted. Keep your words and try again after it finishes.",
    });
  if (
    expected !== undefined &&
    (position === undefined ||
      expected.historyRevision !== position.historyRevision ||
      expected.worktreeEpoch !== position.worktreeEpoch)
  )
    return yield* new HistoryAdmissionRefusedError({
      sessionId,
      reason: "stale_history",
      message:
        "History or files changed since this message was prepared. Review the current conversation and explicitly resume or edit your saved draft.",
    });
});

/** The row a dispatch claimed: its process, stamped with its attempt. */
const heldBy = (claim: DispatchClaim): SQL | undefined =>
  and(
    eq(agentTurns.processId, claim.processId),
    claim.attempt === null
      ? isNull(agentTurns.dispatchAttemptId)
      : eq(agentTurns.dispatchAttemptId, claim.attempt),
  );

/** Unbound, or bound only to the id the claim's own send may have bound. */
const unsentOrBoundTo = (bound: string | null): SQL | undefined =>
  bound === null
    ? isNull(agentTurns.providerTurnId)
    : or(isNull(agentTurns.providerTurnId), eq(agentTurns.providerTurnId, bound));

const harnessTurnRow = (tx: ConversationTx, sessionId: SessionId, providerTurnId: string) =>
  tx
    .select()
    .from(agentTurns)
    .where(and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.providerTurnId, providerTurnId)))
    .limit(1);

const recorded = (turn: AgentTurn): HarnessTurnOpening => ({
  _tag: "Recorded",
  turn,
});
const SLOT_HELD: HarnessTurnOpening = { _tag: "SlotHeld" };

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
  /**
   * Who sent it, when that is known: a live terminal's turns are its owner's, the one person who
   * types there (docs/adr/0013). Null for a mode switch's and an import's.
   */
  readonly author?: string | null;
}

/** The same words, whatever whitespace a terminal's input box changed them by. */
const sameWords = (left: string, right: string): boolean =>
  left.trim().replace(/\s+/g, " ") === right.trim().replace(/\s+/g, " ");

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

/** A session's newest conversation item, by its change-feed `seq`: what it touched last. */
export interface NewestAgentItem {
  readonly sessionId: SessionId;
  readonly kind: AgentItemKind;
  readonly title: string | null;
  readonly data: unknown;
}

/** The later of two times, either of which may be missing. */
const later = (a: Date | null, b: Date | null): Date | null =>
  a === null ? b : b === null || a >= b ? a : b;

/** What the inbox reads of one session's turns and asks (`inboxTurnFacts`). */
export interface InboxTurnFacts {
  readonly sessionId: SessionId;
  /** A turn is queued or running. */
  readonly turnOpen: boolean;
  /** When the newest turn was sent, or the newest ask opened or was answered; null for none. */
  readonly newestAt: Date | null;
}

/** The first message a session was sent, as Mend recorded it (`firstMessages`). */
export interface FirstMessage {
  readonly sessionId: SessionId;
  /** The turn's input: what was sent, with whatever Mend added to it (`requestOfTurn` strips it). */
  readonly input: string;
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
  readonly historyPosition?: HistoryPosition;
  readonly selection?: TurnSelection;
}

/**
 * The turn one dispatch claimed, as only that dispatch may move it while it is unsent. `attempt` is
 * null only for a turn claimed before attempts were recorded (0168).
 */
export interface DispatchClaim {
  readonly sessionId: SessionId;
  readonly processId: SessionProcessId;
  readonly attempt: DispatchAttemptId | null;
}

/** A turn the harness opened on its own, by its provider turn id. */
export interface HarnessTurn {
  readonly providerTurnId: string;
  /** What the harness was answering. */
  readonly reason: string;
  /** Whose login the workspace held when the harness opened it. */
  readonly payer: TurnPayer;
}

/** How a harness turn ended, for one recorded only once it had ended. */
export interface HarnessTurnEnd {
  readonly status: Exclude<AgentTurnStatus, "queued" | "running">;
  readonly usage: AgentTurnUsage | null;
  readonly error: string | null;
}

/** Recorded: the harness turn's row. SlotHeld: another turn runs on the process, so it has none. */
export type HarnessTurnOpening =
  | { readonly _tag: "Recorded"; readonly turn: AgentTurn }
  | { readonly _tag: "SlotHeld" };

/** What else a dispatch's release of its unsent turn settles in the same transaction. */
export interface ClaimRelease {
  /**
   * A provider turn id the dispatch's own `turn.started` may have bound while its send was out,
   * and that its send's answer showed was another turn: the binding is cleared.
   */
  readonly bound?: string | null;
  /** A harness turn that waited for the slot: recorded running once the release frees it. */
  readonly harness?: HarnessTurn | null;
}

/** The process's running turn no provider turn is bound to, and the dispatch that claimed it. */
export interface UnsentClaim {
  readonly turn: AgentTurn;
  readonly attempt: DispatchAttemptId | null;
}

export class AgentControlJournalError extends Schema.TaggedError<AgentControlJournalError>()(
  "AgentControlJournalError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Where an older history window starts: just before this item, in a turn of this ordinal. */
export interface HistoryCursor {
  readonly createdAt: Date;
  readonly id: string;
  readonly ordinal: number;
}

/** A turn range, both ends inclusive and either open; `newest` keeps only that many newest turns. */
export interface HistoryRange {
  readonly from: number | null;
  readonly to: number | null;
  readonly newest: number | null;
}

/** One window of a conversation's history, newest first (`AgentConversationRepo.historyWindow`). */
export interface HistoryWindow {
  /** The window's items, oldest first. */
  readonly items: ReadonlyArray<AgentItem>;
  /** The turns those items are in, and any between them. */
  readonly range: HistoryRange;
  /** Where the next older window starts; null when this one reaches the start. */
  readonly next: HistoryCursor | null;
  /** The session's highest item `seq`: where a reader of this window follows its updates from. */
  readonly feed: number;
}

/**
 * Durable structured conversation state. Provider identities are database keys so replay updates
 * existing rows. `seq` is a session-wide change-feed cursor, not conversation order: every applied
 * update moves the item to the tail so `listItems(after)` re-delivers changed items; render order
 * is `createdAt` (or turn ordinal). Allocation happens under a per-session advisory lock.
 */
export class AgentConversationRepo extends Context.Service<
  AgentConversationRepo,
  {
    readonly messageByClientId: (
      input: SendMessageInput,
    ) => Effect.Effect<SessionMessageResult | null, MessageKeyConflictError>;
    readonly messageById: (id: SessionMessageId) => Effect.Effect<SessionMessageResult>;
    readonly admitSteerMessage: (
      input: SendMessageInput,
      turnId: AgentTurnId,
    ) => Effect.Effect<
      MessageAdmission<SteerMessage>,
      | MessageKeyConflictError
      | SessionStoppingError
      | HistoryAdmissionRefusedError
      | AgentTurnNotFoundError
      | TurnSteerForbiddenError
    >;
    /**
     * A message as a turn queued on `processId`, or, with null, as a waiting turn (SLNT-1237):
     * queued for the session while its conversation starts, before any agent process of it is
     * hosted, and taken by the one that comes up (`takeWaitingTurns`). A waiting turn is admitted
     * only while the session reads `starting`; otherwise `SessionStoppingError`.
     */
    readonly admitTurnMessage: (
      input: SendMessageInput,
      processId: SessionProcessId | null,
      reason: MessageTurnReason,
    ) => Effect.Effect<
      MessageAdmission<TurnMessage>,
      MessageKeyConflictError | SessionStoppingError | HistoryAdmissionRefusedError
    >;
    /**
     * A launch's first message, recorded as the session's opening turn the moment the launch is
     * admitted (SLNT-1237): a waiting turn under the launch's correlation id, which the launch's
     * own submit with that id finds later (`submitTurn`). The turn the id already names when there
     * is one; null, and nothing written, when the session doesn't read `starting` (a resume of a
     * settled session submits its opening turn once its agent runs, as before).
     */
    readonly queueOpeningTurn: (
      sessionId: SessionId,
      input: string,
      author: string | null,
      launchCorrelationId: string,
    ) => Effect.Effect<AgentTurn | null, HistoryAdmissionRefusedError>;
    /** Every waiting turn of the session moves onto `to`, still queued, in order; how many. */
    readonly takeWaitingTurns: (
      sessionId: SessionId,
      to: SessionProcessId,
    ) => Effect.Effect<number>;
    /**
     * Every waiting turn of the session ends, `cancelled` or `failed`, with `error` saying why:
     * the session settled, was stopped, or started in a terminal before any process took them.
     */
    readonly endWaitingTurns: (
      sessionId: SessionId,
      end: { readonly status: "cancelled" | "failed"; readonly error: string },
    ) => Effect.Effect<number>;
    /** A waiting turn's launch correlation id becomes `to`: a relaunch minted a fresh one. */
    readonly rekeyWaitingTurn: (
      sessionId: SessionId,
      from: string,
      to: string,
    ) => Effect.Effect<void>;
    /** Cancels a message's turn that no process took; true when it did. */
    readonly withdrawMessageTurn: (
      id: AgentTurnId,
      processId: SessionProcessId,
    ) => Effect.Effect<boolean>;
    readonly submitTurn: (
      sessionId: SessionId,
      processId: SessionProcessId,
      input: string,
      author: string | null,
      launchCorrelationId?: string | null,
      selection?: TurnSelection,
    ) => Effect.Effect<AgentTurn, SessionStoppingError | HistoryAdmissionRefusedError>;
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
    /**
     * Whether a turn of the session after `ordinal` has been taken to be sent (its `started_at`,
     * which a claim stamps and a put-back clears): a turn's checkpoint taken from here on may hold
     * that turn's changes too (SLNT-1263).
     */
    readonly turnSentAfter: (sessionId: SessionId, ordinal: number) => Effect.Effect<boolean>;
    readonly listConversationTurns: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<ConversationTurn>>;
    readonly admitTurnSteer: (
      input: AdmitTurnSteerInput,
    ) => Effect.Effect<
      { readonly steer: AgentTurnSteer; readonly created: boolean },
      AgentTurnNotFoundError | HistoryAdmissionRefusedError
    >;
    readonly steerByClientId: (
      author: string,
      clientSteerId: string,
    ) => Effect.Effect<AgentTurnSteer | null>;
    readonly settleTurnSteer: (
      id: AgentTurnSteerId,
      delivery: Exclude<AgentTurnSteerDelivery, { readonly _tag: "Sending" | "Queued" }>,
    ) => Effect.Effect<AgentTurnSteer>;
    /**
     * The agent took a steer into its turn, as the process's harness showed it: stamps when, once.
     * A steer that went as a next turn or wasn't sent is never taken; one of another process isn't
     * this process's to stamp. Null when nothing changed.
     */
    readonly markTurnSteerTaken: (
      id: AgentTurnSteerId,
      processId: SessionProcessId,
    ) => Effect.Effect<AgentTurnSteer | null>;
    readonly queueTurnSteer: (
      id: AgentTurnSteerId,
      processId: SessionProcessId | null,
      reason: TurnSteerQueueReason,
    ) => Effect.Effect<AgentTurnSteer>;
    /**
     * A Queued steer whose turn no process will take (its process detached as the turn was
     * queued): the turn is cancelled and the words stay, NotSent. A turn another process took or
     * claimed meanwhile keeps the receipt.
     */
    readonly withdrawTurnSteer: (
      id: AgentTurnSteerId,
      processId: SessionProcessId,
    ) => Effect.Effect<AgentTurnSteer>;
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
    /** Take the process's next queued turn, stamped with `attempt`; null while a turn runs. */
    readonly claimNextTurn: (
      processId: SessionProcessId,
      attempt: DispatchAttemptId,
    ) => Effect.Effect<AgentTurn | null>;
    /**
     * Record a turn the harness opened on its own, running, or ended when `ended` says how. It never
     * moves another turn: while one runs on the process it is not recorded running (SlotHeld).
     * Idempotent by provider turn id.
     */
    readonly openHarnessTurn: (
      sessionId: SessionId,
      processId: SessionProcessId,
      providerTurnId: string,
      reason: string,
      /** Whose login the workspace held when the harness opened it. */
      payer: TurnPayer,
      ended?: HarnessTurnEnd,
    ) => Effect.Effect<HarnessTurnOpening>;
    /** The process's running turn that no provider turn is bound to, with its claim; null if none. */
    readonly unsentClaim: (processId: SessionProcessId) => Effect.Effect<UnsentClaim | null>;
    /**
     * Bind the claimed turn to the provider turn its send started, and record whose login it ran
     * on. Only while it runs unbound (or bound to `replacing`); the same id again is a no-op that
     * still answers the turn. Null when the claim no longer holds it.
     */
    readonly bindOwnSend: (
      claim: DispatchClaim,
      providerTurnId: string,
      payer: TurnPayer,
      replacing?: string | null,
    ) => Effect.Effect<AgentTurn | null>;
    /**
     * Put the claimed, unsent turn back in the queue; null when the claim no longer holds it (a
     * Stop, a hand-over or a restart decided first).
     */
    readonly putBackOwn: (
      claim: DispatchClaim,
      release?: ClaimRelease,
    ) => Effect.Effect<AgentTurn | null>;
    /** Fail the claimed, unsent turn with `error`; null when the claim no longer holds it. */
    readonly failOwn: (
      claim: DispatchClaim,
      error: string,
      release?: ClaimRelease,
    ) => Effect.Effect<AgentTurn | null>;
    /**
     * Record whose login a sent turn ran on (docs/adr/0013, "Every turn records its payer"),
     * replacing what a previous send of the same turn recorded.
     */
    readonly setTurnPayer: (
      id: AgentTurnId,
      payer: TurnPayer,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    /**
     * Fail a queued or running turn, or reword a failed one; a turn that ended otherwise (a
     * Stop's `cancelled`) is never moved, and reads as not found.
     */
    readonly failTurn: (
      id: AgentTurnId,
      error: string,
    ) => Effect.Effect<AgentTurn, AgentTurnNotFoundError>;
    /**
     * Fail a running turn no provider turn is bound to, with `TURN_DELIVERY_UNCONFIRMED`; null when
     * the harness's turn was bound to it or it ended meanwhile.
     */
    readonly failUnconfirmedTurn: (id: AgentTurnId) => Effect.Effect<AgentTurn | null>;
    /**
     * The workspace reached its memory limit during the turn (SLNT-1233): what the kernel
     * stopped, said under the turn. Replaced whole; the turn's status is left as it is.
     */
    readonly setTurnMemoryLimit: (
      id: AgentTurnId,
      hit: MemoryLimitHit,
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
      /** Why a turn on a login with an endpoint could not connect; null or absent otherwise. */
      unreachable?: UnreachableCause | null,
    ) => Effect.Effect<AgentTurn | null>;
    readonly upsertItem: (input: UpsertAgentItemInput) => Effect.Effect<AgentItem>;
    readonly listItems: (
      sessionId: SessionId,
      after: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AgentItem>>;
    /**
     * The conversation's history window older than `before` (null: from the newest): its newest
     * `limit` items, the turn range they cover, and where the next older window starts. Turns and
     * requests are read for the same window (`turnsInRange`, `requestsInRange`), so each read is
     * paginated from the newest end by the same cursor, and none walks the whole history.
     */
    readonly historyWindow: (
      sessionId: SessionId,
      before: HistoryCursor | null,
      limit: number,
    ) => Effect.Effect<HistoryWindow>;
    /** The session's turns with `from <= ordinal <= to` (a null end is open), their steers with them. */
    readonly turnsInRange: (
      sessionId: SessionId,
      range: HistoryRange,
    ) => Effect.Effect<ReadonlyArray<ConversationTurn>>;
    /** The session's requests whose turn is in `range`. */
    readonly requestsInRange: (
      sessionId: SessionId,
      range: HistoryRange,
    ) => Effect.Effect<ReadonlyArray<AgentRequest>>;
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
    /** Each session's oldest request still pending, in one statement; sessions with none are absent. */
    readonly oldestPendingRequests: (
      sessionIds: ReadonlyArray<SessionId>,
    ) => Effect.Effect<ReadonlyArray<AgentRequest>>;
    /**
     * Each session's newest item (the highest `seq`, so the one updated last) while the turn it
     * belongs to still runs, in one statement that reads one index entry per session. A session
     * whose newest item's turn has ended, or that has no item, is absent: a conversation reads
     * `running` between turns too, and its last reply says nothing about work under way.
     */
    readonly newestItems: (
      sessionIds: ReadonlyArray<SessionId>,
    ) => Effect.Effect<ReadonlyArray<NewestAgentItem>>;
    /**
     * Each asked session's turn and ask facts for its inbox row, in two grouped statements (one
     * over turns, one over requests): whether a turn is queued or running, and when the newest
     * turn was sent or the newest ask opened or was answered. A session with neither is absent.
     */
    readonly inboxTurnFacts: (
      sessionIds: ReadonlyArray<SessionId>,
    ) => Effect.Effect<ReadonlyArray<InboxTurnFacts>>;
    /**
     * Each asked session's first message, in one statement: its lowest-ordinal turn that Mend sent
     * (not one the harness opened by itself) and that is still in its history. A session that was
     * never sent a message through Mend (a terminal session typed into) is absent.
     */
    readonly firstMessages: (
      sessionIds: ReadonlyArray<SessionId>,
    ) => Effect.Effect<ReadonlyArray<FirstMessage>>;
    /**
     * The inputs of the first `count` messages Mend sent one session, oldest first, by the same
     * rule as `firstMessages`: turns Mend sent, still in its history. The namer reads past a first
     * message that names nothing ("hi") to the one that does.
     */
    readonly openingMessages: (
      sessionId: SessionId,
      count: number,
    ) => Effect.Effect<ReadonlyArray<string>>;
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
    /**
     * A message for a terminal agent (SLNT-1235): the oldest turn queued on its process becomes
     * the running one, to be typed into the terminal, unless one already runs there. Null when
     * none waits, or one runs.
     */
    readonly startTerminalTurn: (processId: SessionProcessId) => Effect.Effect<AgentTurn | null>;
    /** The words never reached the terminal: the turn waits again, first in line. */
    readonly requeueTerminalTurn: (turnId: AgentTurnId) => Effect.Effect<void>;
    /**
     * A terminal agent ended: a message typed into it that its transcript never showed as a turn
     * reads interrupted, so nothing waits on it forever. Queued ones stay for the next process.
     */
    readonly settleTerminalTurns: (processId: SessionProcessId) => Effect.Effect<void>;
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
    selection: Schema.decodeUnknownSync(Schema.NullOr(TurnSelection))(row.selection),
  });

export const toTurn = (row: typeof agentTurns.$inferSelect): AgentTurn =>
  new AgentTurn({
    ...row,
    processId:
      row.processId ??
      (row.imported
        ? importedTurnProcessIdOf(row.sessionId)
        : waitingTurnProcessIdOf(row.sessionId)),
    mergeBack: Schema.decodeUnknownSync(Schema.Array(MergeBackContext))(row.mergeBack),
    selection: Schema.decodeUnknownSync(Schema.NullOr(TurnSelection))(row.selection),
    memoryLimit: decodeMemoryLimit(row.memoryLimit),
  });
const decodeMemoryLimit = Schema.decodeUnknownSync(Schema.NullOr(MemoryLimitHit));
const toItem = (row: typeof agentItems.$inferSelect): AgentItem =>
  new AgentItem({
    ...row,
    processId: row.processId ?? importedTurnProcessIdOf(row.sessionId),
  });
const toRequest = (row: typeof agentRequests.$inferSelect): AgentRequest => new AgentRequest(row);

/** The turns of a history range, as a condition on `agent_turns`. */
const inRange = (range: HistoryRange) =>
  and(
    range.from === null ? undefined : gte(agentTurns.ordinal, range.from),
    range.to === null ? undefined : lte(agentTurns.ordinal, range.to),
  );

/**
 * Turns with their steers, in order, as the conversation shows them. A steer queued into a later
 * turn names it (`fromSteer`); `origins` adds the steers sent from turns the rows do not hold.
 */
const conversationTurnsOf = (
  rows: ReadonlyArray<{
    readonly turn: typeof agentTurns.$inferSelect;
    readonly steer: typeof agentTurnSteers.$inferSelect | null;
  }>,
  origins: ReadonlyArray<{
    readonly id: AgentTurnSteerId;
    readonly queuedTurnId: AgentTurnId | null;
  }>,
  /** The key each turn's or steer's message was sent under, so a pending message meets it. */
  keyOf: ReadonlyMap<string, ClientMessageId>,
): ReadonlyArray<ConversationTurn> => {
  const grouped = new Map<
    AgentTurnId,
    { turn: typeof agentTurns.$inferSelect; steers: Array<ConversationSteer> }
  >();
  const from = new Map<AgentTurnId, AgentTurnSteerId>();
  for (const origin of origins)
    if (origin.queuedTurnId !== null) from.set(origin.queuedTurnId, origin.id);
  for (const row of rows) {
    const entry = grouped.get(row.turn.id) ?? { turn: row.turn, steers: [] };
    if (row.steer !== null) {
      const steer = new ConversationSteer({
        ...toSteer(row.steer),
        clientMessageId: keyOf.get(row.steer.id) ?? null,
      });
      entry.steers.push(steer);
      if (steer.queuedTurnId !== null) from.set(steer.queuedTurnId, steer.id);
    }
    grouped.set(row.turn.id, entry);
  }
  return [...grouped.values()].map(
    ({ turn, steers }) =>
      new ConversationTurn({
        ...toTurn(turn),
        clientMessageId: keyOf.get(turn.id) ?? null,
        steerSender: turnSteerSender(turn),
        steers,
        fromSteer: from.get(turn.id) ?? null,
      }),
  );
};

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

/**
 * Land native history as completed turns, inside the caller's transaction: under the session's
 * conversation lock, after the existing tail, skipping a turn whose provider turn id is already
 * there. A mode switch's turns name the process whose transcript they came from; an imported
 * conversation's turns name none (`imported`), since nothing in Mend ran them.
 */
export const landHistoryTurns = Effect.fn("AgentConversationRepo.landHistoryTurns")(function* (
  tx: Pick<MendDatabase, "select" | "insert" | "update" | "execute">,
  sessionId: SessionId,
  source: { readonly processId: SessionProcessId } | { readonly imported: true },
  turns: ReadonlyArray<BackfillTurnInput>,
) {
  const processId = "processId" in source ? source.processId : null;
  const outputProcessId = processId ?? importedTurnProcessIdOf(sessionId);
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
  // Mend's own pages are published by a process of the session; an imported turn has none.
  const unshown = yield* pagesWithoutItems(
    tx,
    sessionId,
    processId === null
      ? []
      : turns
          .filter((turn) => !seen.has(turn.providerTurnId))
          .flatMap((turn) => turn.items.flatMap((item) => publishedPageIdOf(item.data) ?? [])),
  );
  // Messages the composer typed into this terminal (SLNT-1235): the turn the transcript shows
  // for each is that message's own row, so it lands there rather than as a copy.
  const delivered =
    processId === null
      ? []
      : yield* tx
          .select()
          .from(agentTurns)
          .where(
            and(
              eq(agentTurns.sessionId, sessionId),
              eq(agentTurns.processId, processId),
              isNull(agentTurns.providerTurnId),
              isNull(agentTurns.withdrawnHistoryRevision),
              inArray(agentTurns.status, ["running", "interrupted"]),
            ),
          )
          .orderBy(asc(agentTurns.ordinal));
  let count = 0;
  for (const turn of turns) {
    if (seen.has(turn.providerTurnId)) continue;
    const bindAt = delivered.findIndex((row) => sameWords(row.input, turn.input));
    const bound = bindAt === -1 ? undefined : delivered.splice(bindAt, 1)[0];
    const [turnRow] =
      bound === undefined
        ? yield* tx
            .insert(agentTurns)
            .values({
              id: AgentTurnId.make(crypto.randomUUID()),
              sessionId,
              processId,
              imported: processId === null,
              ordinal: ordinal++,
              author: turn.author ?? null,
              input: turn.input,
              status: "completed",
              providerTurnId: turn.providerTurnId,
              startedAt: now,
              endedAt: now,
            })
            .returning()
        : yield* tx
            .update(agentTurns)
            .set({ status: "completed", providerTurnId: turn.providerTurnId, endedAt: now })
            .where(eq(agentTurns.id, bound.id))
            .returning();
    if (turnRow === undefined) {
      return yield* Effect.die("agent turn backfill returned no row");
    }
    yield* tx
      .insert(previewPreparations)
      .values({
        turnId: turnRow.id,
        sessionId,
        worktreeId: sql`(SELECT worktree_id FROM agent_sessions WHERE id = ${sessionId})`,
        state: "skipped",
        reason: processId === null ? "imported history" : "terminal history",
        claimId: crypto.randomUUID(),
        claimedAt: now,
        leaseUntil: now,
        decidedAt: now,
      })
      .onConflictDoNothing();
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
          providerOutputProcessId: outputProcessId,
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
      if (page === undefined || processId === null) continue;
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
  expected?: HistoryPosition,
) {
  yield* lockAgentConversation(tx, sessionId);
  yield* assertHistoryAdmission(tx, sessionId, expected);
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

/**
 * Whether the session reads `starting` and nothing has settled or idle-stopped it: the only time
 * a waiting turn is admitted (SLNT-1237). Read under the conversation's lock, which `settle`'s end
 * of the waiting turns takes too, so a waiting turn is either admitted before they end or refused.
 */
const readsStarting = Effect.fn("AgentConversationRepo.readsStarting")(function* (
  tx: ConversationTx,
  sessionId: SessionId,
) {
  const [starting] = yield* tx
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.status, "starting"),
        isNull(agentSessions.settledAt),
        isNull(agentSessions.idleStoppedAt),
      ),
    );
  return starting !== undefined;
});

/** A waiting turn of the session: queued for it, no process holds it, not imported (SLNT-1237). */
const waitingTurnsOf = (sessionId: SessionId) =>
  and(
    eq(agentTurns.sessionId, sessionId),
    isNull(agentTurns.processId),
    eq(agentTurns.imported, false),
    eq(agentTurns.status, "queued"),
  );

const admittedSelection = Effect.fn("AgentConversationRepo.admittedSelection")(function* (
  tx: ConversationTx,
  sessionId: SessionId,
  selection: TurnSelection | null | undefined,
) {
  if (selection !== undefined) return selection;
  const [session] = yield* tx
    .select({
      harness: agentSessions.harness,
      model: agentSessions.model,
      effort: agentSessions.effort,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  return session === undefined
    ? null
    : turnSelectionOf(session.harness, session.model, session.effort);
});

const insertQueuedTurn = Effect.fn("AgentConversationRepo.insertQueuedTurn")(function* (
  tx: ConversationTx,
  turn: {
    readonly sessionId: SessionId;
    /** Null: a waiting turn, queued for the session before any process of it is hosted. */
    readonly processId: SessionProcessId | null;
    readonly input: string;
    readonly author: string | null;
    readonly launchCorrelationId: string | null;
    readonly selection?: TurnSelection | null;
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
      bornHistoryRevision: (yield* historyAdmission(tx, turn.sessionId))[0]?.historyRevision ?? 0,
      selection: yield* admittedSelection(tx, turn.sessionId, turn.selection),
      id: AgentTurnId.make(crypto.randomUUID()),
      ordinal: (position?.value ?? -1) + 1,
      status: "queued",
    })
    .returning();
  if (row === undefined) return yield* Effect.die("agent turn insert returned no row");
  return toTurn(row);
});

const insertTurnSteer = Effect.fn("AgentConversationRepo.insertTurnSteer")(function* (
  tx: ConversationTx,
  target: AgentTurn,
  input: AdmitTurnSteerInput,
) {
  const [position] = yield* tx
    .select({ value: max(agentTurnSteers.ordinal) })
    .from(agentTurnSteers)
    .where(eq(agentTurnSteers.turnId, target.id));
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
      selection: yield* admittedSelection(tx, target.sessionId, input.selection),
      delivery: { _tag: "Sending" },
      clientSteerId: input.clientSteerId,
    })
    .returning();
  if (row === undefined) return yield* Effect.die("steer insert returned no row");
  return toSteer(row);
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

export type SteerMessage = Extract<SessionMessageResult, { readonly _tag: "Steer" }>;
export type TurnMessage = Extract<SessionMessageResult, { readonly _tag: "Turn" }>;

/** Created: this request wrote the message and delivers it. Replay: an earlier one with its key did. */
export type MessageAdmission<R extends SessionMessageResult> =
  | { readonly _tag: "Created"; readonly result: R }
  | { readonly _tag: "Replay"; readonly result: SessionMessageResult };

const isSteerMessage = (result: SessionMessageResult): result is SteerMessage =>
  result._tag === "Steer";
const isTurnMessage = (result: SessionMessageResult): result is TurnMessage =>
  result._tag === "Turn";

const bindMessage = (
  tx: ConversationTx,
  input: SendMessageInput,
  result: SessionMessageResult,
  reason: MessageTurnReason | null,
) =>
  tx.insert(sessionMessages).values({
    id: result.messageId,
    sessionId: input.sessionId,
    author: input.sender,
    clientMessageId: input.clientMessageId,
    queueRequested: input.intent === "queue",
    turnId: result._tag === "Turn" ? result.turn.id : null,
    steerId: result._tag === "Steer" ? result.steer.id : null,
    turnReason: reason,
  });

/** Cancels a turn no process took: still queued on `processId`, never claimed or sent. */
const withdrawUntakenTurn = Effect.fn("AgentConversationRepo.withdrawUntakenTurn")(function* (
  db: Pick<MendDatabase, "update">,
  id: AgentTurnId,
  processId: SessionProcessId,
) {
  const [turn] = yield* db
    .update(agentTurns)
    .set({
      status: "cancelled",
      endedAt: yield* DateTime.nowAsDate,
      error: "The conversation's process ended before taking this turn.",
    })
    .where(
      and(
        eq(agentTurns.id, id),
        eq(agentTurns.processId, processId),
        eq(agentTurns.status, "queued"),
        isNull(agentTurns.startedAt),
        isNull(agentTurns.providerTurnId),
      ),
    )
    .returning({ sessionId: agentTurns.sessionId });
  return turn ?? null;
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
    /** A change already committed is its caller's to act on, whether or not feeds heard of it. */
    const notifyCommitted = (sessionId: SessionId) =>
      notify(sessionId).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("conversation: a committed change's notification failed").pipe(
                Effect.annotateLogs({ sessionId }),
              ),
        ),
      );

    const readMessage = Effect.fn("AgentConversationRepo.readMessage")(function* (
      tx: Pick<MendDatabase, "select">,
      where: SQL,
    ) {
      const [row] = yield* tx
        .select()
        .from(sessionMessages)
        .leftJoin(agentTurns, eq(sessionMessages.turnId, agentTurns.id))
        .leftJoin(agentTurnSteers, eq(sessionMessages.steerId, agentTurnSteers.id))
        .where(where)
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return null;
      const binding = row.session_messages;
      if (row.agent_turns !== null)
        return {
          binding,
          result: messageOutcome(
            {
              _tag: "Turn",
              messageId: binding.id,
              turn: toTurn(row.agent_turns),
            },
            binding.turnReason,
          ),
        };
      if (row.agent_turn_steers !== null)
        return {
          binding,
          result: messageOutcome(
            {
              _tag: "Steer",
              messageId: binding.id,
              steer: toSteer(row.agent_turn_steers),
            },
            null,
          ),
        };
      return yield* Effect.die("message target disappeared");
    });

    const readMessageKey = Effect.fn("AgentConversationRepo.readMessageKey")(function* (
      tx: Pick<MendDatabase, "select">,
      input: SendMessageInput,
    ) {
      if (input.clientMessageId === null) return null;
      const existing = yield* readMessage(
        tx,
        sql`${sessionMessages.author} = ${input.sender} AND ${sessionMessages.clientMessageId} = ${input.clientMessageId}`,
      );
      if (existing === null) return null;
      const { binding, result } = existing;
      const words = result._tag === "Turn" ? result.turn.input : result.steer.input;
      if (
        binding.sessionId !== input.sessionId ||
        words !== input.input ||
        !selectionMatches(
          input.selection,
          result._tag === "Turn" ? result.turn.selection : result.steer.selection,
        ) ||
        binding.queueRequested !== (input.intent === "queue")
      )
        return yield* new MessageKeyConflictError({
          clientMessageId: input.clientMessageId,
          message: "This message key was already used for another request.",
        });
      return result;
    });

    const messageByClientId = (input: SendMessageInput) => readMessageKey(db, input);
    const messageById = (id: SessionMessageId) =>
      readMessage(db, eq(sessionMessages.id, id)).pipe(
        Effect.flatMap((row) =>
          row === null ? Effect.die("message disappeared") : Effect.succeed(row.result),
        ),
      );

    const replayUnderLock = Effect.fn("AgentConversationRepo.replayUnderLock")(function* (
      tx: ConversationTx,
      input: SendMessageInput,
    ) {
      if (input.clientMessageId === null) return null;
      yield* tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`mend:message:${input.sender}:${input.clientMessageId.toLowerCase()}`}))`,
      );
      const replay = yield* readMessageKey(tx, input);
      return replay === null ? null : ({ _tag: "Replay", result: replay } as const);
    });

    /** A commit whose acknowledgement was lost: this attempt's own row is still its to deliver. */
    const recoverCommitted = <R extends SessionMessageResult>(
      input: SendMessageInput,
      messageId: SessionMessageId,
      cause: unknown,
      isOwn: (result: SessionMessageResult) => result is R,
    ): Effect.Effect<MessageAdmission<R>, MessageKeyConflictError> =>
      Effect.gen(function* () {
        const own = yield* readMessage(db, eq(sessionMessages.id, messageId));
        if (own !== null && isOwn(own.result)) return { _tag: "Created", result: own.result };
        const replay = yield* readMessageKey(db, input);
        if (replay === null) return yield* Effect.die(cause);
        return { _tag: "Replay", result: replay };
      });

    const admitSteerMessage = Effect.fn("AgentConversationRepo.admitSteerMessage")(function* (
      input: SendMessageInput,
      turnId: AgentTurnId,
    ) {
      const messageId = SessionMessageId.make(crypto.randomUUID());
      const admitted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const replay = yield* replayUnderLock(tx, input);
            if (replay !== null) return replay;
            if (!(yield* lockOpenConversation(tx, input.sessionId, input.historyPosition)))
              return yield* new SessionStoppingError({
                sessionId: input.sessionId,
              });
            const [turn] = yield* tx
              .select()
              .from(agentTurns)
              .where(eq(agentTurns.id, turnId))
              .for("update");
            if (turn === undefined || turn.sessionId !== input.sessionId)
              return yield* new AgentTurnNotFoundError({ turnId });
            const sender = turnSteerSender(turn);
            if (sender !== input.sender)
              return yield* new TurnSteerForbiddenError({
                turnId: turn.id,
                reason: sender === null ? "no-sender" : "not-sender",
                message: "Only this turn's sender may steer it.",
              });
            const steer = yield* insertTurnSteer(tx, toTurn(turn), {
              turnId: turn.id,
              author: input.sender,
              input: input.input,
              ...(input.selection === undefined ? {} : { selection: input.selection }),
              clientSteerId: null,
            });
            const result = messageOutcome({ _tag: "Steer", messageId, steer }, null);
            yield* bindMessage(tx, input, result, null);
            return { _tag: "Created", result } as const;
          }),
        )
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) => Effect.die(error)),
          Effect.catchTag("SqlError", (error) =>
            recoverCommitted(input, messageId, error, isSteerMessage),
          ),
        );
      if (admitted._tag === "Created") yield* notifyCommitted(input.sessionId);
      return admitted;
    });

    const admitTurnMessage = Effect.fn("AgentConversationRepo.admitTurnMessage")(function* (
      input: SendMessageInput,
      processId: SessionProcessId | null,
      reason: MessageTurnReason,
    ) {
      const messageId = SessionMessageId.make(crypto.randomUUID());
      const admitted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const replay = yield* replayUnderLock(tx, input);
            if (replay !== null) return replay;
            if (
              !(yield* lockOpenConversation(tx, input.sessionId, input.historyPosition)) ||
              (processId === null && !(yield* readsStarting(tx, input.sessionId)))
            )
              return yield* new SessionStoppingError({
                sessionId: input.sessionId,
              });
            const turn = yield* insertQueuedTurn(tx, {
              sessionId: input.sessionId,
              processId,
              input: input.input,
              ...(input.selection === undefined ? {} : { selection: input.selection }),
              author: input.sender,
              launchCorrelationId: null,
            });
            const result = messageOutcome({ _tag: "Turn", messageId, turn }, reason);
            yield* bindMessage(tx, input, result, reason);
            return { _tag: "Created", result } as const;
          }),
        )
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) => Effect.die(error)),
          Effect.catchTag("SqlError", (error) =>
            recoverCommitted(input, messageId, error, isTurnMessage),
          ),
        );
      if (admitted._tag === "Created") yield* notifyCommitted(input.sessionId);
      return admitted;
    });

    const withdrawMessageTurn = Effect.fn("AgentConversationRepo.withdrawMessageTurn")(function* (
      id: AgentTurnId,
      processId: SessionProcessId,
    ) {
      const withdrawn = yield* withdrawUntakenTurn(db, id, processId).pipe(Effect.orDie);
      if (withdrawn !== null) yield* notify(withdrawn.sessionId);
      return withdrawn !== null;
    });

    const queueOpeningTurn = Effect.fn("AgentConversationRepo.queueOpeningTurn")(function* (
      sessionId: SessionId,
      input: string,
      author: string | null,
      launchCorrelationId: string,
    ) {
      const queued = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            if (
              !(yield* lockOpenConversation(tx, sessionId)) ||
              !(yield* readsStarting(tx, sessionId))
            )
              return null;
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
            if (existing !== undefined) return { turn: toTurn(existing), created: false };
            const turn = yield* insertQueuedTurn(tx, {
              sessionId,
              processId: null,
              input,
              author,
              launchCorrelationId,
            });
            return { turn, created: true };
          }),
        )
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
          Effect.catchTag("SqlError", Effect.die),
        );
      if (queued === null) return null;
      if (queued.created) yield* notify(sessionId);
      return queued.turn;
    });

    const takeWaitingTurns = Effect.fn("AgentConversationRepo.takeWaitingTurns")(function* (
      sessionId: SessionId,
      to: SessionProcessId,
    ) {
      const rows = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentConversation(tx, sessionId);
            // A history operation fences the conversation: nothing moves while it runs, as for
            // `requeueQueuedTurns`.
            if ((yield* historyAdmission(tx, sessionId))[0]?.fence != null) return [];
            return yield* tx
              .update(agentTurns)
              .set({ processId: to })
              .where(and(waitingTurnsOf(sessionId), isNull(agentTurns.withdrawnHistoryRevision)))
              .returning({ id: agentTurns.id });
          }),
        )
        .pipe(Effect.orDie);
      if (rows.length > 0) yield* notify(sessionId);
      return rows.length;
    });

    const endWaitingTurns = Effect.fn("AgentConversationRepo.endWaitingTurns")(function* (
      sessionId: SessionId,
      end: { readonly status: "cancelled" | "failed"; readonly error: string },
    ) {
      const rows = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentConversation(tx, sessionId);
            return yield* tx
              .update(agentTurns)
              .set({ status: end.status, error: end.error, endedAt: yield* DateTime.nowAsDate })
              .where(waitingTurnsOf(sessionId))
              .returning({ id: agentTurns.id });
          }),
        )
        .pipe(Effect.orDie);
      if (rows.length > 0) yield* notify(sessionId);
      return rows.length;
    });

    const rekeyWaitingTurn = Effect.fn("AgentConversationRepo.rekeyWaitingTurn")(function* (
      sessionId: SessionId,
      from: string,
      to: string,
    ) {
      yield* db
        .update(agentTurns)
        .set({ launchCorrelationId: to })
        .where(and(waitingTurnsOf(sessionId), eq(agentTurns.launchCorrelationId, from)))
        .pipe(Effect.orDie);
    });

    const submitTurn = Effect.fn("AgentConversationRepo.submitTurn")(function* (
      sessionId: SessionId,
      processId: SessionProcessId,
      input: string,
      author: string | null,
      launchCorrelationId: string | null = null,
      selection?: TurnSelection,
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
                  existing.withdrawnHistoryRevision === null &&
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
              ...(selection === undefined ? {} : { selection }),
            });
          }),
        )
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
          Effect.catchTag("SqlError", Effect.die),
        );
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

    const turnSentAfter = Effect.fn("AgentConversationRepo.turnSentAfter")(function* (
      sessionId: SessionId,
      ordinal: number,
    ) {
      const [row] = yield* db
        .select({ id: agentTurns.id })
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.sessionId, sessionId),
            gt(agentTurns.ordinal, ordinal),
            isNotNull(agentTurns.startedAt),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row !== undefined;
    });

    /**
     * The keys a session's messages were sent under, by the turn or steer each became: every one
     * of the session's (`scope` null), or only those of the named turns and steers.
     */
    const messageKeysOf = Effect.fn("AgentConversationRepo.messageKeysOf")(function* (
      sessionId: SessionId,
      scope: {
        readonly turnIds: ReadonlyArray<AgentTurnId>;
        readonly steerIds: ReadonlyArray<AgentTurnSteerId>;
      } | null,
    ) {
      const keyed = isNotNull(sessionMessages.clientMessageId);
      const keys =
        scope !== null && scope.turnIds.length === 0 && scope.steerIds.length === 0
          ? []
          : yield* db
              .select({
                turnId: sessionMessages.turnId,
                steerId: sessionMessages.steerId,
                clientMessageId: sessionMessages.clientMessageId,
              })
              .from(sessionMessages)
              .where(
                scope === null
                  ? and(eq(sessionMessages.sessionId, sessionId), keyed)
                  : and(
                      keyed,
                      or(
                        scope.turnIds.length === 0
                          ? undefined
                          : inArray(sessionMessages.turnId, [...scope.turnIds]),
                        scope.steerIds.length === 0
                          ? undefined
                          : inArray(sessionMessages.steerId, [...scope.steerIds]),
                      ),
                    ),
              )
              .pipe(Effect.orDie);
      const keyOf = new Map<string, ClientMessageId>();
      for (const key of keys) {
        if (key.clientMessageId === null) continue;
        if (key.turnId !== null) keyOf.set(key.turnId, key.clientMessageId);
        if (key.steerId !== null) keyOf.set(key.steerId, key.clientMessageId);
      }
      return keyOf;
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
        return conversationTurnsOf(rows, [], yield* messageKeysOf(sessionId, null));
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
            yield* assertHistoryAdmission(tx, turn.sessionId, input.historyPosition);
            const [target] = yield* tx
              .select()
              .from(agentTurns)
              .where(eq(agentTurns.id, turn.id))
              .for("update");
            if (target === undefined || target.withdrawnHistoryRevision !== null) return null;
            const steer = yield* insertTurnSteer(tx, toTurn(target), {
              ...input,
              clientSteerId,
            });
            return { steer, created: true };
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.catchTag("EffectDrizzleQueryError", Effect.die),
        );
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

    const markTurnSteerTaken = Effect.fn("AgentConversationRepo.markTurnSteerTaken")(function* (
      id: AgentTurnSteerId,
      processId: SessionProcessId,
    ) {
      const now = yield* DateTime.nowAsDate;
      const [changed] = yield* db
        .update(agentTurnSteers)
        .set({ takenAt: now, updatedAt: now })
        .where(
          and(
            eq(agentTurnSteers.id, id),
            eq(agentTurnSteers.processId, processId),
            isNull(agentTurnSteers.takenAt),
            sql`${agentTurnSteers.delivery}->>'_tag' IN ('Sending', 'Accepted', 'Unknown')`,
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      if (changed === undefined) return null;
      yield* notify(changed.sessionId);
      return toSteer(changed);
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
                    selection: row.selection,
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
      processId: SessionProcessId,
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
            if ((yield* withdrawUntakenTurn(tx, delivery.turnId, processId)) === null)
              return { steer: toSteer(row), changed: false };
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
      attempt: DispatchAttemptId,
    ) {
      const claimed = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentProcess(tx, processId);
            const [process] = yield* tx
              .select({ sessionId: sessionProcesses.sessionId })
              .from(sessionProcesses)
              .where(eq(sessionProcesses.id, processId));
            if (
              process === undefined ||
              (yield* historyAdmission(tx, process.sessionId))[0]?.fence != null
            )
              return null;
            const [running] = yield* tx
              .select({ id: agentTurns.id })
              .from(agentTurns)
              .where(and(eq(agentTurns.processId, processId), eq(agentTurns.status, "running")))
              .limit(1);
            if (running !== undefined) return null;
            const [queued] = yield* tx
              .select()
              .from(agentTurns)
              .where(
                and(
                  eq(agentTurns.processId, processId),
                  eq(agentTurns.status, "queued"),
                  isNull(agentTurns.withdrawnHistoryRevision),
                ),
              )
              .orderBy(asc(agentTurns.ordinal))
              .limit(1)
              .for("update", { skipLocked: true });
            if (queued === undefined) return null;
            const now = yield* DateTime.nowAsDate;
            let mergeBack = Schema.decodeUnknownSync(Schema.Array(MergeBackContext))(
              queued.mergeBack,
            );
            if (queued.author !== null && queued.origin === "request" && mergeBack.length === 0) {
              const pending = yield* tx
                .select({ context: sessionMergeBacks.context })
                .from(sessionMergeBacks)
                .where(
                  and(
                    eq(sessionMergeBacks.targetSessionId, process.sessionId),
                    eq(sessionMergeBacks.status, "pending"),
                  ),
                )
                .orderBy(asc(sessionMergeBacks.id));
              mergeBack = pending.map((row) =>
                Schema.decodeUnknownSync(MergeBackContext)(row.context),
              );
              if (mergeBack.length > 0)
                yield* tx
                  .update(sessionMergeBacks)
                  .set({
                    status: "consumed",
                    targetTurnId: queued.id,
                    consumedAt: now,
                  })
                  .where(
                    and(
                      eq(sessionMergeBacks.targetSessionId, process.sessionId),
                      eq(sessionMergeBacks.status, "pending"),
                    ),
                  );
            }
            const [row] = yield* tx
              .update(agentTurns)
              .set({
                status: "running",
                startedAt: now,
                dispatchAttemptId: attempt,
                mergeBack: Schema.encodeSync(Schema.Array(MergeBackContext))(mergeBack),
              })
              .where(and(eq(agentTurns.id, queued.id), eq(agentTurns.status, "queued")))
              .returning();
            return row === undefined ? null : toTurn(row);
          }),
        )
        .pipe(Effect.orDie);
      if (claimed !== null) yield* notifyCommitted(claimed.sessionId);
      return claimed;
    });

    const insertHarnessTurn = Effect.fn("AgentConversationRepo.insertHarnessTurn")(function* (
      tx: ConversationTx,
      sessionId: SessionId,
      processId: SessionProcessId,
      harness: HarnessTurn,
      ended: HarnessTurnEnd | null,
    ) {
      const [position] = yield* tx
        .select({ value: max(agentTurns.ordinal) })
        .from(agentTurns)
        .where(eq(agentTurns.sessionId, sessionId));
      const now = yield* DateTime.nowAsDate;
      const [row] = yield* tx
        .insert(agentTurns)
        .values({
          id: AgentTurnId.make(crypto.randomUUID()),
          sessionId,
          processId,
          ordinal: (position?.value ?? -1) + 1,
          author: null,
          origin: "harness",
          bornHistoryRevision: (yield* historyAdmission(tx, sessionId))[0]?.historyRevision ?? 0,
          input: harness.reason,
          status: ended?.status ?? "running",
          providerTurnId: harness.providerTurnId,
          usage: ended?.usage ?? null,
          error: ended?.error ?? null,
          billedUserId: harness.payer.userId,
          billedAccountId: harness.payer.accountId,
          billedAccountName: harness.payer.accountName,
          startedAt: now,
          endedAt: ended === null ? null : now,
        })
        .returning();
      if (row === undefined) return yield* Effect.die("harness turn insert returned no row");
      return toTurn(row);
    });

    const openHarnessTurn = Effect.fn("AgentConversationRepo.openHarnessTurn")(function* (
      sessionId: SessionId,
      processId: SessionProcessId,
      providerTurnId: string,
      reason: string,
      payer: TurnPayer,
      ended?: HarnessTurnEnd,
    ) {
      const opened = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // The conversation lock orders the ordinal against submitTurn; the process lock
            // orders the running turn against claimNextTurn and the claim's own moves.
            yield* lockAgentConversation(tx, sessionId);
            yield* lockAgentProcess(tx, processId);
            const [existing] = yield* harnessTurnRow(tx, sessionId, providerTurnId);
            if (existing !== undefined) {
              if (ended === undefined || existing.status !== "running")
                return {
                  opening: recorded(toTurn(existing)),
                  changed: false,
                };
              const [row] = yield* tx
                .update(agentTurns)
                .set({ ...ended, endedAt: yield* DateTime.nowAsDate })
                .where(eq(agentTurns.id, existing.id))
                .returning();
              if (row === undefined)
                return yield* Effect.die("harness turn update returned no row");
              return { opening: recorded(toTurn(row)), changed: true };
            }
            if ((yield* historyAdmission(tx, sessionId))[0]?.fence != null)
              return { opening: SLOT_HELD, changed: false };
            if (ended === undefined) {
              const [running] = yield* tx
                .select({ id: agentTurns.id })
                .from(agentTurns)
                .where(and(eq(agentTurns.processId, processId), eq(agentTurns.status, "running")))
                .limit(1);
              if (running !== undefined) return { opening: SLOT_HELD, changed: false };
            }
            const turn = yield* insertHarnessTurn(
              tx,
              sessionId,
              processId,
              { providerTurnId, reason, payer },
              ended ?? null,
            );
            return { opening: recorded(turn), changed: true };
          }),
        )
        .pipe(Effect.orDie);
      if (opened.changed) yield* notifyCommitted(sessionId);
      return opened.opening;
    });

    const unsentClaim = Effect.fn("AgentConversationRepo.unsentClaim")(function* (
      processId: SessionProcessId,
    ) {
      const [row] = yield* db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.processId, processId),
            eq(agentTurns.status, "running"),
            isNull(agentTurns.providerTurnId),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : { turn: toTurn(row), attempt: row.dispatchAttemptId };
    });

    const bindOwnSend = Effect.fn("AgentConversationRepo.bindOwnSend")(function* (
      claim: DispatchClaim,
      providerTurnId: string,
      payer: TurnPayer,
      replacing: string | null = null,
    ) {
      const bound = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentProcess(tx, claim.processId);
            if ((yield* historyAdmission(tx, claim.sessionId))[0]?.fence != null) return null;
            const [row] = yield* tx
              .update(agentTurns)
              .set({
                providerTurnId,
                billedUserId: payer.userId,
                billedAccountId: payer.accountId,
                billedAccountName: payer.accountName,
              })
              .where(
                and(
                  heldBy(claim),
                  isNull(agentTurns.withdrawnHistoryRevision),
                  or(
                    eq(agentTurns.providerTurnId, providerTurnId),
                    and(eq(agentTurns.status, "running"), unsentOrBoundTo(replacing)),
                  ),
                ),
              )
              .returning();
            return row === undefined ? null : toTurn(row);
          }),
        )
        .pipe(Effect.orDie);
      if (bound !== null) yield* notifyCommitted(bound.sessionId);
      return bound;
    });

    /**
     * One move of a claimed, unsent turn by the dispatch that claimed it: a compare-and-set under
     * the process lock, which frees the process for a harness turn that waited for it.
     */
    const releaseOwn = (
      claim: DispatchClaim,
      change: Partial<typeof agentTurns.$inferInsert>,
      release: ClaimRelease,
    ) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const harness = release.harness ?? null;
            if (harness !== null) yield* lockAgentConversation(tx, claim.sessionId);
            yield* lockAgentProcess(tx, claim.processId);
            if ((yield* historyAdmission(tx, claim.sessionId))[0]?.fence != null) return null;
            const [row] = yield* tx
              .update(agentTurns)
              .set({ ...change, providerTurnId: null })
              .where(
                and(
                  heldBy(claim),
                  isNull(agentTurns.withdrawnHistoryRevision),
                  eq(agentTurns.status, "running"),
                  unsentOrBoundTo(release.bound ?? null),
                ),
              )
              .returning();
            if (row === undefined) return null;
            if (harness !== null) {
              const [existing] = yield* harnessTurnRow(tx, claim.sessionId, harness.providerTurnId);
              if (existing === undefined)
                yield* insertHarnessTurn(tx, claim.sessionId, claim.processId, harness, null);
            }
            return toTurn(row);
          }),
        )
        .pipe(
          Effect.orDie,
          Effect.tap((turn) => (turn === null ? Effect.void : notifyCommitted(turn.sessionId))),
        );

    const putBackOwn = Effect.fn("AgentConversationRepo.putBackOwn")(function* (
      claim: DispatchClaim,
      release: ClaimRelease = {},
    ) {
      return yield* releaseOwn(claim, { status: "queued", startedAt: null }, release);
    });

    const failOwn = Effect.fn("AgentConversationRepo.failOwn")(function* (
      claim: DispatchClaim,
      error: string,
      release: ClaimRelease = {},
    ) {
      const endedAt = yield* DateTime.nowAsDate;
      return yield* releaseOwn(claim, { status: "failed", error, endedAt }, release);
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
      return {
        running: row?.running ?? 0,
        lastUpdatedAt: row?.lastUpdatedAt ?? null,
      };
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

    const failTurn = Effect.fn("AgentConversationRepo.failTurn")(function* (
      id: AgentTurnId,
      error: string,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ status: "failed", error, endedAt: yield* DateTime.nowAsDate })
        .where(
          and(eq(agentTurns.id, id), inArray(agentTurns.status, ["queued", "running", "failed"])),
        )
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AgentTurnNotFoundError({ turnId: id });
      yield* notify(row.sessionId);
      return toTurn(row);
    });

    const failUnconfirmedTurn = Effect.fn("AgentConversationRepo.failUnconfirmedTurn")(function* (
      id: AgentTurnId,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({
          status: "failed",
          error: TURN_DELIVERY_UNCONFIRMED,
          endedAt: yield* DateTime.nowAsDate,
        })
        .where(
          and(
            eq(agentTurns.id, id),
            eq(agentTurns.status, "running"),
            isNull(agentTurns.providerTurnId),
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return null;
      yield* notifyCommitted(row.sessionId);
      return toTurn(row);
    });

    const setTurnMemoryLimit = Effect.fn("AgentConversationRepo.setTurnMemoryLimit")(function* (
      id: AgentTurnId,
      hit: MemoryLimitHit,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({ memoryLimit: hit })
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
      unreachable: UnreachableCause | null = null,
    ) {
      const [row] = yield* db
        .update(agentTurns)
        .set({
          status,
          usage,
          error,
          unreachable,
          endedAt: yield* DateTime.nowAsDate,
        })
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

    /** Turns whose window holds no items are few: the newest this many when a window is empty. */
    const ITEMLESS_TURNS = 50;

    const historyWindow = Effect.fn("AgentConversationRepo.historyWindow")(function* (
      sessionId: SessionId,
      before: HistoryCursor | null,
      limit: number,
    ) {
      // The window by `agent_items_session_created_idx`, then its turns' ordinals by their key.
      const itemRows = yield* db
        .select()
        .from(agentItems)
        .where(
          before === null
            ? eq(agentItems.sessionId, sessionId)
            : and(
                eq(agentItems.sessionId, sessionId),
                sql`(${agentItems.createdAt}, ${agentItems.id}) < (${before.createdAt}, ${before.id})`,
              ),
        )
        .orderBy(desc(agentItems.createdAt), desc(agentItems.id))
        .limit(limit + 1)
        .pipe(Effect.orDie);
      const turnIds = [...new Set(itemRows.map((row) => row.turnId))];
      const ordinals = new Map(
        turnIds.length === 0
          ? []
          : (yield* db
              .select({ id: agentTurns.id, ordinal: agentTurns.ordinal })
              .from(agentTurns)
              .where(inArray(agentTurns.id, turnIds))
              .pipe(Effect.orDie)).map((row) => [row.id, row.ordinal] as const),
      );
      const rows = itemRows.map((item) => ({
        item,
        ordinal: ordinals.get(item.turnId) ?? 0,
      }));
      const held = rows.slice(0, limit);
      const oldest = held.at(-1);
      const to = before?.ordinal ?? null;
      const [feedRow] = yield* db
        .select({ feed: max(agentItems.seq) })
        .from(agentItems)
        .where(eq(agentItems.sessionId, sessionId))
        .pipe(Effect.orDie);
      const feed = feedRow?.feed ?? 0;
      if (oldest === undefined) {
        // No items left: the turns that remain, which have none (a turn that failed to start).
        return {
          items: [],
          range: { from: null, to, newest: ITEMLESS_TURNS },
          next: null,
          feed,
        };
      }
      const from = Math.min(...held.map((row) => row.ordinal));
      const olderTurn =
        rows.length > limit
          ? true
          : (yield* db
              .select({ id: agentTurns.id })
              .from(agentTurns)
              .where(and(eq(agentTurns.sessionId, sessionId), lt(agentTurns.ordinal, from)))
              .limit(1)
              .pipe(Effect.orDie)).length > 0;
      return {
        items: held.map((row) => toItem(row.item)).toReversed(),
        range: { from, to, newest: null },
        next: olderTurn
          ? {
              createdAt: oldest.item.createdAt,
              id: oldest.item.id,
              ordinal: oldest.ordinal,
            }
          : null,
        feed,
      } satisfies HistoryWindow;
    });

    const turnsInRange = Effect.fn("AgentConversationRepo.turnsInRange")(function* (
      sessionId: SessionId,
      range: HistoryRange,
    ) {
      const picked = yield* db
        .select({ id: agentTurns.id })
        .from(agentTurns)
        .where(and(eq(agentTurns.sessionId, sessionId), inRange(range)))
        .orderBy(desc(agentTurns.ordinal))
        .limit(range.newest ?? 10_000)
        .pipe(Effect.orDie);
      const ids = picked.map((row) => row.id);
      if (ids.length === 0) return [];
      const [rows, origins] = yield* Effect.all(
        [
          db
            .select({ turn: agentTurns, steer: agentTurnSteers })
            .from(agentTurns)
            .leftJoin(agentTurnSteers, eq(agentTurnSteers.turnId, agentTurns.id))
            .where(inArray(agentTurns.id, ids))
            .orderBy(asc(agentTurns.ordinal), asc(agentTurnSteers.ordinal))
            .pipe(Effect.orDie),
          // A turn a steer started names that steer, wherever (in which turn) it was sent.
          db
            .select({
              id: agentTurnSteers.id,
              queuedTurnId: agentTurnSteers.queuedTurnId,
            })
            .from(agentTurnSteers)
            .where(inArray(agentTurnSteers.queuedTurnId, ids))
            .pipe(Effect.orDie),
        ],
        { concurrency: 2 },
      );
      const keyOf = yield* messageKeysOf(sessionId, {
        turnIds: ids,
        steerIds: rows.flatMap((row) => (row.steer === null ? [] : [row.steer.id])),
      });
      return conversationTurnsOf(rows, origins, keyOf);
    });

    const requestsInRange = Effect.fn("AgentConversationRepo.requestsInRange")(function* (
      sessionId: SessionId,
      range: HistoryRange,
    ) {
      const rows = yield* db
        .select({ request: agentRequests })
        .from(agentRequests)
        .innerJoin(agentTurns, eq(agentTurns.id, agentRequests.turnId))
        .where(and(eq(agentRequests.sessionId, sessionId), inRange(range)))
        .orderBy(asc(agentRequests.createdAt))
        .pipe(Effect.orDie);
      return rows.map((row) => toRequest(row.request));
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

    const oldestPendingRequests = Effect.fn("AgentConversationRepo.oldestPendingRequests")(
      function* (sessionIds: ReadonlyArray<SessionId>) {
        if (sessionIds.length === 0) return [];
        const rows = yield* db
          .selectDistinctOn([agentRequests.sessionId])
          .from(agentRequests)
          .where(
            and(
              inArray(agentRequests.sessionId, [...sessionIds]),
              eq(agentRequests.status, "pending"),
            ),
          )
          .orderBy(asc(agentRequests.sessionId), asc(agentRequests.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toRequest);
      },
    );

    const firstMessages = Effect.fn("AgentConversationRepo.firstMessages")(function* (
      sessionIds: ReadonlyArray<SessionId>,
    ) {
      if (sessionIds.length === 0) return [];
      return yield* db
        .selectDistinctOn([agentTurns.sessionId], {
          sessionId: agentTurns.sessionId,
          input: agentTurns.input,
        })
        .from(agentTurns)
        .where(
          and(
            inArray(agentTurns.sessionId, [...sessionIds]),
            eq(agentTurns.origin, "request"),
            isNull(agentTurns.withdrawnHistoryRevision),
          ),
        )
        .orderBy(asc(agentTurns.sessionId), asc(agentTurns.ordinal))
        .pipe(Effect.orDie);
    });

    const openingMessages = Effect.fn("AgentConversationRepo.openingMessages")(function* (
      sessionId: SessionId,
      count: number,
    ) {
      const rows = yield* db
        .select({ input: agentTurns.input })
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.sessionId, sessionId),
            eq(agentTurns.origin, "request"),
            isNull(agentTurns.withdrawnHistoryRevision),
          ),
        )
        .orderBy(asc(agentTurns.ordinal))
        .limit(count)
        .pipe(Effect.orDie);
      return rows.map((row) => row.input);
    });

    const inboxTurnFacts = Effect.fn("AgentConversationRepo.inboxTurnFacts")(function* (
      sessionIds: ReadonlyArray<SessionId>,
    ) {
      if (sessionIds.length === 0) return [];
      const [turns, asks] = yield* Effect.all(
        [
          db
            .select({
              sessionId: agentTurns.sessionId,
              newest: max(agentTurns.createdAt),
              // Queued as `claimNextTurn` takes it: a turn withdrawn from history never runs.
              open: sql<boolean>`bool_or(${agentTurns.status} = 'running' OR (${agentTurns.status} = 'queued' AND ${agentTurns.withdrawnHistoryRevision} IS NULL))`,
            })
            .from(agentTurns)
            .where(inArray(agentTurns.sessionId, [...sessionIds]))
            .groupBy(agentTurns.sessionId),
          db
            .select({
              sessionId: agentRequests.sessionId,
              opened: max(agentRequests.createdAt),
              decided: max(agentRequests.decidedAt),
            })
            .from(agentRequests)
            .where(inArray(agentRequests.sessionId, [...sessionIds]))
            .groupBy(agentRequests.sessionId),
        ],
        { concurrency: 2 },
      ).pipe(Effect.orDie);
      const facts = new Map<SessionId, { turnOpen: boolean; newestAt: Date | null }>();
      for (const row of turns)
        facts.set(row.sessionId, { turnOpen: row.open, newestAt: row.newest });
      for (const row of asks) {
        const before = facts.get(row.sessionId) ?? { turnOpen: false, newestAt: null };
        facts.set(row.sessionId, {
          turnOpen: before.turnOpen,
          newestAt: later(before.newestAt, later(row.opened, row.decided)),
        });
      }
      return [...facts].map(([sessionId, fact]): InboxTurnFacts => ({ sessionId, ...fact }));
    });

    const newestItems = Effect.fn("AgentConversationRepo.newestItems")(function* (
      sessionIds: ReadonlyArray<SessionId>,
    ) {
      if (sessionIds.length === 0) return [];
      // LATERAL with LIMIT 1: one step down `agent_items_session_seq_idx` per session, however
      // long its conversation.
      const newest = db
        .select({
          kind: agentItems.kind,
          title: agentItems.title,
          data: agentItems.data,
          turnId: agentItems.turnId,
        })
        .from(agentItems)
        .where(eq(agentItems.sessionId, agentSessions.id))
        .orderBy(desc(agentItems.seq))
        .limit(1)
        .as("newest");
      const rows = yield* db
        .select({
          sessionId: agentSessions.id,
          kind: newest.kind,
          title: newest.title,
          data: newest.data,
        })
        .from(agentSessions)
        .crossJoinLateral(newest)
        .innerJoin(
          agentTurns,
          and(eq(agentTurns.id, newest.turnId), eq(agentTurns.status, "running")),
        )
        .where(inArray(agentSessions.id, [...sessionIds]))
        .pipe(Effect.orDie);
      return rows.map(
        (row): NewestAgentItem => ({
          sessionId: row.sessionId,
          kind: row.kind,
          title: row.title,
          data: row.data,
        }),
      );
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
      // Readers hear of the turn itself too: a waiting turn has no process whose hooks say so
      // (SLNT-1237), and it may have no request to cancel.
      const sessionId = rows[0]?.sessionId ?? (yield* byTurnId(turnId))?.sessionId;
      if (sessionId !== undefined) yield* notify(sessionId);
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
        .transaction((tx) => landHistoryTurns(tx, sessionId, { processId }, turns))
        .pipe(Effect.orDie);
      if (landed > 0) yield* notify(sessionId);
      return landed;
    });

    const startTerminalTurn = Effect.fn("AgentConversationRepo.startTerminalTurn")(function* (
      processId: SessionProcessId,
    ) {
      const started = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentProcess(tx, processId);
            const open = yield* tx
              .select()
              .from(agentTurns)
              .where(
                and(
                  eq(agentTurns.processId, processId),
                  isNull(agentTurns.withdrawnHistoryRevision),
                  inArray(agentTurns.status, ["queued", "running"]),
                ),
              )
              .orderBy(asc(agentTurns.ordinal));
            const next = open[0];
            if (next === undefined || open.some((turn) => turn.status === "running")) return null;
            // Typed in now, after whatever the terminal ran while it waited: it reads there too.
            yield* lockAgentConversation(tx, next.sessionId);
            const [position] = yield* tx
              .select({ value: max(agentTurns.ordinal) })
              .from(agentTurns)
              .where(eq(agentTurns.sessionId, next.sessionId));
            const last = position?.value ?? next.ordinal;
            const now = yield* DateTime.nowAsDate;
            const [row] = yield* tx
              .update(agentTurns)
              .set({
                status: "running",
                startedAt: now,
                ...(last > next.ordinal ? { ordinal: last + 1 } : {}),
              })
              .where(and(eq(agentTurns.id, next.id), eq(agentTurns.status, "queued")))
              .returning();
            return row === undefined ? null : toTurn(row);
          }),
        )
        .pipe(Effect.orDie);
      if (started !== null) yield* notify(started.sessionId);
      return started;
    });

    const requeueTerminalTurn = Effect.fn("AgentConversationRepo.requeueTerminalTurn")(function* (
      turnId: AgentTurnId,
    ) {
      const rows = yield* db
        .update(agentTurns)
        .set({ status: "queued", startedAt: null })
        .where(
          and(
            eq(agentTurns.id, turnId),
            eq(agentTurns.status, "running"),
            isNull(agentTurns.providerTurnId),
          ),
        )
        .returning({ sessionId: agentTurns.sessionId })
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
    });

    const settleTerminalTurns = Effect.fn("AgentConversationRepo.settleTerminalTurns")(function* (
      processId: SessionProcessId,
    ) {
      const now = yield* DateTime.nowAsDate;
      const rows = yield* db
        .update(agentTurns)
        .set({ status: "interrupted", endedAt: now })
        .where(
          and(
            eq(agentTurns.processId, processId),
            eq(agentTurns.status, "running"),
            isNull(agentTurns.providerTurnId),
          ),
        )
        .returning({ sessionId: agentTurns.sessionId })
        .pipe(Effect.orDie);
      const first = rows[0];
      if (first !== undefined) yield* notify(first.sessionId);
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
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockAgentProcess(tx, from);
            const [process] = yield* tx
              .select({ sessionId: sessionProcesses.sessionId })
              .from(sessionProcesses)
              .where(eq(sessionProcesses.id, from));
            if (
              process === undefined ||
              (yield* historyAdmission(tx, process.sessionId))[0]?.fence != null
            )
              return [];
            return yield* tx
              .update(agentTurns)
              .set({ processId: to })
              .where(
                and(
                  eq(agentTurns.processId, from),
                  eq(agentTurns.status, "queued"),
                  isNull(agentTurns.withdrawnHistoryRevision),
                ),
              )
              .returning({ sessionId: agentTurns.sessionId });
          }),
        )
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
      messageByClientId,
      messageById,
      admitSteerMessage,
      admitTurnMessage,
      queueOpeningTurn,
      takeWaitingTurns,
      endWaitingTurns,
      rekeyWaitingTurn,
      withdrawMessageTurn,
      submitTurn,
      byTurnId,
      byLaunchCorrelation,
      byProviderTurnId,
      listTurns,
      turnSentAfter,
      listConversationTurns,
      admitTurnSteer,
      steerByClientId,
      settleTurnSteer,
      markTurnSteerTaken,
      queueTurnSteer,
      withdrawTurnSteer,
      recoverSendingSteers,
      recordProtocolControl,
      protocolControls,
      openTurns,
      claimNextTurn,
      openHarnessTurn,
      unsentClaim,
      bindOwnSend,
      putBackOwn,
      failOwn,
      taskActivity,
      setTurnPayer,
      failTurn,
      failUnconfirmedTurn,
      setTurnMemoryLimit,
      setTurnIntent,
      claimTurnLanding,
      decideTurnLanding,
      completeTurn,
      upsertItem,
      listItems,
      historyWindow,
      turnsInRange,
      requestsInRange,
      turnMessages,
      turnItems,
      openRequest,
      byRequestId,
      listRequests,
      oldestPendingRequests,
      newestItems,
      inboxTurnFacts,
      firstMessages,
      openingMessages,
      hasPendingRequests,
      prepareRequestResponse,
      completeRequestResponse,
      failRequestResponse,
      resolveRequest,
      resolveProviderRequest,
      cancelOpenForTurn,
      cancelOpenForProcess,
      backfillConversation,
      startTerminalTurn,
      requeueTerminalTurn,
      settleTerminalTurns,
      resetSendingResponses,
      requeueQueuedTurns,
      protocolCursor,
      saveProtocolCursor,
    };
  }),
);
