import {
  AgentProtocolError,
  ClaudeAdapter,
  CodexAdapter,
  type AgentBackgroundWork,
  type AgentControlCheckpoint,
  type AgentQuiescence,
  type AgentRehydrateOptions,
  type AgentSession,
} from "@mend/agent-protocol";
import {
  AgentConversationRepo,
  AgentTurnNotFoundError,
  type AgentRequestAlreadyResolvedError,
  type AgentRequestNotFoundError,
  type DispatchClaim,
  type HarnessTurn,
  SessionProcessesRepo,
  SessionsRepo,
} from "@mend/db";
import {
  DispatchAttemptId,
  type AgentTurnId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentInputAnswers,
  AgentRequest,
  AgentTurn,
  SessionProcess,
  TurnPayer,
} from "@mend/domain/workbench";
import {
  type SendMessageInput,
  type SessionMessageResult,
  type MessageChoice,
  type MessageKeyConflictError,
  type MessageTurnReason,
  CONVERSATION_UNREPORTED_WAIT_MS,
  CONVERSATION_WAIT_BOUNDS_MS,
  STARTED_BEFORE_STEERING,
  TURN_DELIVERY_UNCONFIRMED,
  UNREPORTED_WORK_REFUSAL,
  type AgentTurnSteer,
  type TurnSteerQueueReason,
} from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import type { InteractiveSession } from "@sealant/sdk";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import * as Context from "effect/Context";
import * as Semaphore from "effect/Semaphore";

import { HAND_OVER_NOT_NOW } from "./conversation-steps.ts";
import {
  failureName,
  makeTurnSteering,
  openSteerGate,
  type InvalidTurnSteerError,
  type TurnSteerForbiddenError,
  type TurnSteerKeyConflictError,
  type SteerTurnInput,
} from "./protocol-steer.ts";

/** A live protocol process or provider request cannot be addressed by this Mend process. */
export class ProtocolHostNotLiveError extends Schema.TaggedError<ProtocolHostNotLiveError>()(
  "ProtocolHostNotLiveError",
  { processId: Schema.String },
) {}

export type TurnSteerError =
  | ProtocolHostNotLiveError
  | AgentTurnNotFoundError
  | TurnSteerForbiddenError
  | InvalidTurnSteerError
  | TurnSteerKeyConflictError;

export type MessageSendError = ProtocolHostNotLiveError | MessageKeyConflictError;

/** Hooks that return protocol observations to the owning session engine. */
export interface ProtocolHostHooks {
  readonly onRequestChanged: (sessionId: SessionId) => Effect.Effect<void>;
  readonly onTurnCompleted: (turn: AgentTurn) => Effect.Effect<void>;
  /**
   * Shared steering (docs/adr/0016, decision 6) for a process that runs as a person: who each
   * queued turn runs as, and the hand-over to another person's process. Absent: every turn is
   * sent to this process, as before.
   */
  readonly sharedControl?: ProtocolSharedControl;
}

export type SharedControlDecision =
  | { readonly kind: "send" }
  /** Another person's turn, or this person's in the neutral context: a new process runs it. */
  | { readonly kind: "hand-over"; readonly sender: string }
  /** Not sent: the turn fails with these words (shared control was turned off, say). */
  | { readonly kind: "refuse"; readonly words: string };

/**
 * What holds the next sender's turn while the conversation's process finishes its own work
 * (decision 6, "A new sender waits for the previous sender's background work"): nothing is killed.
 */
export interface ConversationWait {
  readonly sessionId: SessionId;
  readonly processId: SessionProcessId;
  /** The turn that waits; the turns behind it wait with it. */
  readonly turnId: AgentTurnId;
  /** Whose process finishes: the person it runs as. */
  readonly runsAs: string | null;
  /** Whose turn waits. */
  readonly sender: string;
  readonly openTurn: boolean;
  readonly work: ReadonlyArray<AgentBackgroundWork>;
}

export interface ProtocolSharedControl {
  readonly decide: (turn: AgentTurn) => Effect.Effect<SharedControlDecision>;
  /** The waiting line changed; null once nothing holds the turn any more. */
  readonly waiting: (wait: ConversationWait | null) => Effect.Effect<void>;
  /**
   * The conversation's process is quiescent: stop it and start the next one as `sender`, in the
   * same workspace. The new process attaches here and takes the conversation's queued turns.
   */
  readonly handOver: (
    sender: string,
    /** The turn that waits: failed with the words when the hand-over cannot finish. */
    turnId: AgentTurnId,
    check: HandOverCheck,
  ) => Effect.Effect<void, SealantPlatformError>;
}

/** What the engine asks of the host at the stop itself (review 2 of mend#572, P2-2). */
export { HAND_OVER_NOT_NOW };

export interface HandOverCheck {
  /**
   * Asked after every preparation (the sender's login, the workspace, their user, the take) and
   * right before the stop: the turn still waits for this sender and the process is still
   * quiescent. False: nothing is stopped or written, the take is given back, and the hand-over
   * fails with `HAND_OVER_NOT_NOW`, which the host reads as "keep waiting".
   */
  readonly stillQuiescent: Effect.Effect<boolean>;
  /** Session crons the wait stopped waiting for at its bound: they end with the process. */
  readonly endedCrons: number;
}

/** What a turn Codex started on its own after its process was told to stop is recorded as. */
export const INTERRUPTED_BY_HAND_OVER = "interrupted by the hand-over";

/** How often a waiting turn looks at the process it waits for. */
const WAIT_POLL = "250 millis";

/**
 * The quiescence a waiting turn acts on: a session cron, or work the harness would not say anything
 * about, is waited for at most its bound from when this wait first saw it (review of mend#572, P3-2
 * and P3-3); the waiting line says the bound. `firstSeen` is the wait's own.
 */
export const waitedOut = (
  quiescence: AgentQuiescence,
  firstSeen: Map<string, number>,
  now: number,
  bounds: Readonly<
    Partial<Record<AgentBackgroundWork["kind"], number>>
  > = CONVERSATION_WAIT_BOUNDS_MS,
): AgentQuiescence => {
  const work = quiescence.work.filter((item) => {
    const bound = bounds[item.kind];
    if (bound === undefined) return true;
    const key = `${item.kind}:${item.id}`;
    const seen = firstSeen.get(key) ?? now;
    firstSeen.set(key, seen);
    return now - seen < bound;
  });
  return {
    ...quiescence,
    work,
    quiescent: !quiescence.openTurn && work.length === 0 && quiescence.settleMs === 0,
  };
};

/** How a wait for quiescence ended. */
interface WaitOutcome {
  readonly outcome: "quiescent" | "abandoned" | "cannot-tell";
  /** Session crons it stopped waiting for at their bound. */
  readonly endedCrons: number;
}
const WAIT_ABANDONED: WaitOutcome = { outcome: "abandoned", endedCrons: 0 };

/** Options needed to initialize a protocol adapter after the pipe process starts. */
export interface AttachProtocolProcessInput {
  readonly process: SessionProcess;
  readonly pipe: InteractiveSession;
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly permissionMode: "bypass" | "ask";
  readonly hooks: ProtocolHostHooks;
  /**
   * Whose login the workspace launched with (docs/adr/0013-whoever-sends-a-turn-pays.md): the
   * session owner's, or a capture-mode join's lease holder's. Null when Mend cannot say.
   */
  readonly launchedWithLoginOf: string | null;
  /**
   * The full path of the conversation's file a resume continues, in a conversation home
   * (docs/adr/0016, decision 6, "Resume never forks"); null or absent otherwise.
   */
  readonly resumePath?: string | null;
  /**
   * The person the process runs as in a person-layout executor (decision 1): the payer of every
   * turn it runs, a sender's, one it opens itself or one Mend starts. On attach it takes the
   * conversation's queued turns, wherever they were queued. Null or absent: root, as before.
   */
  readonly runsAs?: string | null;
}

/**
 * Re-attach to a pipe that survived a Mend restart (restart policy v2). The
 * harness never observed the disconnect; the adapter rebuilds its correlation
 * state from the durable record plus a full replay of the recorded output.
 */
export interface RehydrateProtocolProcessInput extends AttachProtocolProcessInput {
  /** Recorded output high water at probe time; dispatch stays gated until replay passes it. */
  readonly highWater: bigint;
}

interface ProviderEventPosition {
  readonly outputSequence: bigint;
  readonly eventIndex: number;
}

type TurnCompleted = Extract<AgentEvent, { readonly _tag: "turn.completed" }>;

/** What the harness said about a dispatch's own send while the send's answer was out. */
interface SendWatch {
  /** Whose login the turn runs on. */
  readonly payer: TurnPayer;
  /** The turn a `turn.started` reported meanwhile, bound until the answer names another. */
  started: string | null;
  /** Turn ends that matched no turn, or `started`'s: whose they were waits for the answer. */
  readonly held: Array<TurnCompleted>;
}

/**
 * Where a process's dispatch is with the turn it claimed as `attempt`. While the turn is unsent,
 * only this dispatch moves it.
 */
type DispatchPhase =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Claiming"; readonly attempt: DispatchAttemptId }
  | { readonly _tag: "Claimed"; readonly attempt: DispatchAttemptId; readonly turn: AgentTurn }
  | {
      readonly _tag: "Writing";
      readonly attempt: DispatchAttemptId;
      readonly turn: AgentTurn;
      readonly send: SendWatch;
    }
  | { readonly _tag: "Written"; readonly attempt: DispatchAttemptId; readonly turn: AgentTurn };

const sendWatch = (entry: HostedProcess): SendWatch | null =>
  entry.dispatch._tag === "Writing" ? entry.dispatch.send : null;

interface HostedProcess {
  readonly process: SessionProcess;
  readonly adapter: AgentSession;
  readonly pipe: InteractiveSession;
  readonly hooks: ProtocolHostHooks;
  readonly dispatchPermit: Semaphore.Semaphore;
  readonly steerPermit: Semaphore.Semaphore;
  readonly abort: AbortController;
  readonly flushItems: Effect.Effect<void>;
  /** Non-null while a rehydrate replay is still behind its high water — dispatch waits on it. */
  readonly gate: Deferred.Deferred<void> | null;
  readonly steerGate: Deferred.Deferred<void> | null;
  /**
   * The login the workspace holds (docs/adr/0013, "The host remembers what the workspace holds"):
   * the one it launched with, or the person the process runs as (docs/adr/0016).
   */
  holds: TurnPayer;
  readonly runsAs: string | null;
  /** A hand-over to this person's process holds the queue (decision 6). */
  handingOverTo: string | null;
  /** The process was told to stop: a turn its harness opens now ends with it. */
  stopping: boolean;
  steerHolds: number;
  dispatch: DispatchPhase;
  /**
   * A turn the harness opened on its own while another turn held the process: recorded once a
   * dispatch frees the process, or as ended when it ends first.
   */
  parked: HarnessTurn | null;
}

const claimOf = (entry: HostedProcess, attempt: DispatchAttemptId | null): DispatchClaim => ({
  sessionId: entry.process.sessionId,
  processId: entry.process.id,
  attempt,
});

/** A claim's move that freed the process recorded the harness turn waiting for it. */
const released = (entry: HostedProcess, harness: HarnessTurn | null, turn: AgentTurn | null) => {
  if (turn !== null && harness !== null && entry.parked === harness) entry.parked = null;
};

/**
 * The login a conversation's workspace launches with: Mend creates it with `{ claude: true }` or
 * `{ codex: true }`, the launching person's chosen default. Core reports neither that account's id
 * nor its name at create, so both stay unknown.
 */
const launchLogin = (userId: string | null): TurnPayer => ({
  userId,
  accountId: null,
  accountName: null,
});

/**
 * Make the workspace hold the login the next turn runs on, and say whose it is (docs/adr/0013,
 * "The switch sits in dispatch"). Until Core can write another login into a live workspace, every
 * turn runs on the one the workspace holds; the switch replaces this with the turn's sender's.
 */
const loginForTurn = (entry: HostedProcess): Effect.Effect<TurnPayer> =>
  Effect.succeed(entry.holds);

/**
 * Process-local ownership of live protocol adapters. Durable turns, items, requests, and replay
 * identities stay in AgentConversationRepo; this service owns only byte streams and pending calls.
 */
export class ProtocolHost extends Context.Service<
  ProtocolHost,
  {
    readonly attach: (
      input: AttachProtocolProcessInput,
    ) => Effect.Effect<void, SealantPlatformError>;
    /** Boot-time re-attachment to a surviving pipe; a no-op when the process is already hosted. */
    readonly rehydrate: (
      input: RehydrateProtocolProcessInput,
    ) => Effect.Effect<void, SealantPlatformError>;
    readonly submitTurn: (
      sessionId: SessionId,
      input: string,
      author: string | null,
      launchCorrelationId?: string | null,
    ) => Effect.Effect<AgentTurn, ProtocolHostNotLiveError>;
    readonly sendMessage: (
      input: SendMessageInput,
      choice: MessageChoice,
    ) => Effect.Effect<SessionMessageResult, MessageSendError>;
    readonly steerTurn: (input: SteerTurnInput) => Effect.Effect<AgentTurnSteer, TurnSteerError>;
    readonly interruptTurn: (turnId: AgentTurnId) => Effect.Effect<void, ProtocolHostNotLiveError>;
    readonly respondRequest: (
      request: AgentRequest,
      response:
        | { readonly decision: AgentApprovalDecision; readonly answers?: never }
        | { readonly answers: AgentInputAnswers; readonly decision?: never },
      decidedBy: string,
    ) => Effect.Effect<
      AgentRequest,
      ProtocolHostNotLiveError | AgentRequestNotFoundError | AgentRequestAlreadyResolvedError
    >;
    readonly detach: (processId: SessionProcessId) => Effect.Effect<void>;
    readonly has: (processId: SessionProcessId) => Effect.Effect<boolean>;
    /**
     * What a hosted process has in flight now (docs/adr/0016, decision 6); null when this Mend
     * does not host it.
     */
    readonly quiescence: (processId: SessionProcessId) => Effect.Effect<AgentQuiescence | null>;
    /**
     * Wait until a hosted process is quiescent (decided, then re-checked after the settle), saying
     * what it waits for as it goes; nothing is killed. A process this Mend does not host, or one
     * that ended, waits for nothing.
     */
    readonly awaitQuiescent: (
      processId: SessionProcessId,
      waiting?: (quiescence: AgentQuiescence) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    /** End one piece of background work from the waiting line (Claude's task stop, Codex's terminate and goal clear). */
    readonly endWork: (
      processId: SessionProcessId,
      work: Pick<AgentBackgroundWork, "kind" | "id">,
    ) => Effect.Effect<void, ProtocolHostNotLiveError>;
    /**
     * The process stops for the conversation's next one (decision 6, "The stop"): a turn its
     * harness started on its own is recorded as interrupted by the hand-over, under its person, a
     * turn claimed but never sent goes back to the queue, and the queued turns stay for the next
     * process. Then it is detached.
     */
    readonly detachForHandOver: (
      processId: SessionProcessId,
      /** Turns submitted until the next process starts queue on the conversation (the default). */
      queueOnConversation?: boolean,
    ) => Effect.Effect<void>;
  }
>()("@mend/sessions/ProtocolHost") {}

const adapterFor = (harness: string | null) =>
  harness === "claude" ? ClaudeAdapter : CodexAdapter;

const toPlatformError = (operation: string, cause: unknown): SealantPlatformError =>
  new SealantPlatformError({
    code: "agent_protocol_failed",
    status: null,
    message: `Agent protocol ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

/**
 * Runs `attempt` again, a second apart, until it succeeds or the host stops it. For reads and
 * writes that must land once storage answers again.
 */
const retried = <A>(
  attempt: Effect.Effect<A>,
  warning: string,
  about: Readonly<Record<string, string>>,
): Effect.Effect<A> =>
  Effect.gen(function* () {
    for (;;) {
      const done = yield* Effect.exit(attempt);
      if (Exit.isSuccess(done)) return done.value;
      if (Cause.hasInterruptsOnly(done.cause)) return yield* Effect.failCause(done.cause);
      yield* Effect.logWarning(warning).pipe(
        Effect.annotateLogs({ ...about, failure: failureName(done.cause) }),
      );
      yield* Effect.sleep("1 second");
    }
  });

/** `retried`, given up once `live` says the process it is for is gone. */
const untilItLands = (
  attempt: Effect.Effect<void>,
  warning: string,
  about: Readonly<Record<string, string>>,
  live: () => boolean = () => true,
): Effect.Effect<void> =>
  retried(
    attempt.pipe(
      Effect.catchCause((cause) =>
        live() || Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
      ),
    ),
    warning,
    about,
  );

export const ProtocolHostLive: Layer.Layer<
  ProtocolHost,
  never,
  AgentConversationRepo | SessionProcessesRepo | SessionsRepo
> = Layer.effect(
  ProtocolHost,
  Effect.gen(function* () {
    const conversations = yield* AgentConversationRepo;
    const processes = yield* SessionProcessesRepo;
    const sessions = yield* SessionsRepo;
    const scope = yield* Effect.scope;
    const hosted = new Map<SessionProcessId, HostedProcess>();
    /**
     * Conversations between a stop and the next start (decision 6): a turn submitted now queues on
     * the conversation (on the stopping process's row, which the next process takes on attach).
     */
    const handingOver = new Map<SessionId, SessionProcessId>();

    const lookupTurn = Effect.fn("ProtocolHost.lookupTurn")(function* (
      sessionId: SessionId,
      providerTurnId: string,
    ) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const turn = yield* conversations.byProviderTurnId(sessionId, providerTurnId);
        if (turn !== null) return turn;
        yield* Effect.sleep("10 millis");
      }
      return null;
    });

    /** Fails a queued turn and says so; a turn that ended otherwise meanwhile (a Stop) is left alone. */
    const failTurnAndReport = (entry: HostedProcess, turnId: AgentTurnId, words: string) =>
      conversations.failTurn(turnId, words).pipe(
        Effect.flatMap(entry.hooks.onTurnCompleted),
        Effect.catchTag("AgentTurnNotFoundError", () => Effect.void),
      );

    /** Every dispatch of this host that holds a claim: no one else moves its turn. */
    const liveAttempts = new Set<DispatchAttemptId>();
    /** Left by a dispatch that is gone, or claimed before attempts were recorded. */
    const heldByNoDispatch = (attempt: DispatchAttemptId | null) =>
      attempt === null || !liveAttempts.has(attempt);

    /** The harness turn that waits for the process, unless the process is being stopped. */
    const waitingHarness = (entry: HostedProcess): HarnessTurn | null =>
      entry.stopping || hosted.get(entry.process.id) !== entry ? null : entry.parked;

    /** An ended turn: its open requests close, and the engine hears of it. */
    const reportEnded = (entry: HostedProcess, turn: AgentTurn) =>
      Effect.gen(function* () {
        yield* conversations.cancelOpenForTurn(turn.id);
        yield* entry.hooks.onRequestChanged(entry.process.sessionId);
        yield* entry.hooks.onTurnCompleted(turn);
      });

    /** Puts back the claimed, unsent turn; the harness turn waiting for the process takes it. */
    const putBack = (
      entry: HostedProcess,
      attempt: DispatchAttemptId,
      bound: string | null = null,
    ) =>
      Effect.gen(function* () {
        const harness = waitingHarness(entry);
        const turn = yield* conversations.putBackOwn(claimOf(entry, attempt), { bound, harness });
        released(entry, harness, turn);
        return turn;
      });

    /**
     * Fails the claimed, unsent turn with `words` and says so; true when it did. A turn a Stop,
     * a hand-over or a restart decided first is left alone.
     */
    const failClaimed = (
      entry: HostedProcess,
      attempt: DispatchAttemptId,
      words: string,
      bound: string | null = null,
    ) =>
      Effect.gen(function* () {
        const harness = waitingHarness(entry);
        const turn = yield* conversations.failOwn(claimOf(entry, attempt), words, {
          bound,
          harness,
        });
        released(entry, harness, turn);
        if (turn === null) return false;
        yield* entry.hooks.onTurnCompleted(turn);
        return true;
      });

    /** A turn's end, matched by its provider turn id only; null when no turn has that id. */
    const applyCompletion = (entry: HostedProcess, ended: TurnCompleted) =>
      Effect.gen(function* () {
        const turn = yield* conversations.completeTurn(
          ended.providerTurnId,
          entry.process.sessionId,
          ended.status,
          ended.usage,
          ended.error,
        );
        if (turn !== null) yield* reportEnded(entry, turn);
        return turn;
      });

    /**
     * A turn's end. One no turn matches while a send is out may be that send's own (Codex can end
     * a fast turn before it answers): it waits for the answer. A waiting harness turn that ends is
     * recorded as ended. Anything else is nobody's turn and changes no row.
     */
    const settleCompletion = (entry: HostedProcess, ended: TurnCompleted): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (;;) {
          const send = sendWatch(entry);
          if (send !== null && send.started === ended.providerTurnId) {
            send.held.push(ended);
            return;
          }
          if ((yield* applyCompletion(entry, ended)) !== null) return;
          const parked = entry.parked;
          if (parked !== null && parked.providerTurnId === ended.providerTurnId) {
            entry.parked = null;
            const opening = yield* conversations.openHarnessTurn(
              entry.process.sessionId,
              entry.process.id,
              parked.providerTurnId,
              parked.reason,
              parked.payer,
              { status: ended.status, usage: ended.usage, error: ended.error },
            );
            if (opening._tag === "Recorded") yield* reportEnded(entry, opening.turn);
            return;
          }
          if (send === null) return;
          if (sendWatch(entry) === send) {
            send.held.push(ended);
            return;
          }
          // The send was answered meanwhile, and bound before it stopped holding ends: once more.
        }
      });

    /**
     * Records the turn the harness took for this send, again until it lands. A claim another
     * decided meanwhile (a Stop, a hand-over, a restart) binds nothing, and what was written is
     * interrupted. Then the ends the send held are applied, its own by id, the rest dropped.
     */
    const finishSend = (
      entry: HostedProcess,
      phase: Extract<DispatchPhase, { readonly _tag: "Writing" }>,
      providerTurnId: string,
    ) =>
      Effect.gen(function* () {
        const { attempt, turn, send } = phase;
        const replacing =
          send.started !== null && send.started !== providerTurnId ? send.started : null;
        if (replacing !== null)
          yield* Effect.logWarning(
            "protocol host: Codex answered a send with another turn than the one that started meanwhile",
          ).pipe(Effect.annotateLogs({ turnId: turn.id, started: replacing, providerTurnId }));
        const bound = yield* retried(
          Effect.suspend(() =>
            conversations.bindOwnSend(
              claimOf(entry, attempt),
              providerTurnId,
              send.payer,
              replacing,
            ),
          ),
          "protocol host: a sent turn was not recorded",
          { turnId: turn.id },
        );
        entry.dispatch = { _tag: "Written", attempt, turn };
        const own = send.held.filter((ended) => ended.providerTurnId === providerTurnId);
        if (bound === null && own.length === 0)
          yield* entry.adapter.interrupt().pipe(Effect.ignore);
        for (const ended of own) yield* applyCompletion(entry, ended);
      });

    /**
     * After a failure mid-dispatch, the turn this pass claimed goes back or is settled, again until
     * that lands: a turn left running and unbound would block the process's queue for good.
     */
    const leaveNothingStuck = (entry: HostedProcess): Effect.Effect<void> => {
      const phase = entry.dispatch;
      const live = () => hosted.get(entry.process.id) === entry;
      switch (phase._tag) {
        case "Idle":
        case "Written":
          return Effect.void;
        case "Claiming":
        case "Claimed":
          // A claim whose answer was lost may have committed: its attempt names what it took.
          return untilItLands(
            Effect.asVoid(putBack(entry, phase.attempt)),
            "protocol host: a claimed turn was not put back",
            { processId: entry.process.id },
            live,
          );
        case "Writing":
          // The next turn is dispatched however the settling went: one whose answer was lost may
          // have landed, and a turn still running holds the queue by itself.
          return untilItLands(
            Effect.asVoid(failClaimed(entry, phase.attempt, TURN_DELIVERY_UNCONFIRMED)),
            "protocol host: an unconfirmed turn was not settled",
            { turnId: phase.turn.id },
            live,
          ).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                live() ? Effect.asVoid(Effect.forkIn(dispatchNext(entry), scope)) : Effect.void,
              ),
            ),
          );
      }
    };

    const dispatchOne = (entry: HostedProcess): Effect.Effect<"next" | "done"> => {
      const attempt = DispatchAttemptId.make(crypto.randomUUID());
      return Effect.gen(function* () {
        liveAttempts.add(attempt);
        entry.dispatch = { _tag: "Claiming", attempt };
        const turn = yield* conversations.claimNextTurn(entry.process.id, attempt);
        if (turn === null) return "done";
        entry.dispatch = { _tag: "Claimed", attempt, turn };
        const steering = entry.hooks.sharedControl;
        if (steering !== undefined) {
          const decision = yield* steering.decide(turn);
          if (decision.kind === "refuse") {
            yield* failClaimed(entry, attempt, decision.words);
            return "next";
          }
          if (decision.kind === "hand-over") {
            // An agent that cannot say what it runs (a Codex started before shared steering)
            // is never stopped on a guess: it takes its own person's turns as before, and
            // nobody else's until it ends or restarts (review 2 of mend#572, P2-1).
            if (!(yield* entry.adapter.reportsBackgroundWork())) {
              if (decision.sender !== entry.runsAs) {
                yield* failClaimed(entry, attempt, STARTED_BEFORE_STEERING);
                return "next";
              }
            } else {
              yield* putBack(entry, attempt);
              yield* beginHandOver(entry, turn, decision.sender, steering);
              return "done";
            }
          }
        }
        const payer = yield* loginForTurn(entry);
        // A stop that began meanwhile puts back what was claimed: nothing may be written now.
        if (hosted.get(entry.process.id) !== entry || entry.stopping) {
          yield* putBack(entry, attempt);
          return "done";
        }
        const writing = {
          _tag: "Writing",
          attempt,
          turn,
          send: { payer, started: null, held: [] },
        } as const satisfies DispatchPhase;
        entry.dispatch = writing;
        const sent = yield* entry.adapter.sendTurn(turn.input).pipe(Effect.result);
        if (sent._tag === "Success") {
          yield* finishSend(entry, writing, sent.success);
          return "done";
        }
        const failure = sent.failure;
        const uncertain =
          failure._tag === "AgentTurnDeliveryError" && failure.certainty === "uncertain";
        const started = writing.send.started;
        // The answer was lost, and the harness said meanwhile that the turn started: it was written.
        if (uncertain && started !== null) {
          yield* finishSend(entry, writing, started);
          return "done";
        }
        // From here what started meanwhile was another turn: the send was refused or never written.
        // Busy: the harness is in a turn of its own, and that turn's end dispatches this one.
        // Not written: the next trigger dispatches it, never a loop here.
        if (
          failure._tag === "AgentTurnBusyError" ||
          (failure._tag === "AgentTurnDeliveryError" && failure.certainty === "not-written")
        ) {
          entry.dispatch = { _tag: "Claimed", attempt, turn };
          yield* putBack(entry, attempt, started);
          return "done";
        }
        if (uncertain)
          return (yield* failClaimed(entry, attempt, TURN_DELIVERY_UNCONFIRMED)) ? "next" : "done";
        yield* failClaimed(entry, attempt, String(failure), started);
        return "next";
      }).pipe(
        Effect.onError(() => leaveNothingStuck(entry)),
        Effect.ensuring(
          Effect.sync(() => {
            entry.dispatch = { _tag: "Idle" };
            liveAttempts.delete(attempt);
          }),
        ),
      );
    };

    const dispatchNext = (entry: HostedProcess): Effect.Effect<void> =>
      entry.dispatchPermit.withPermit(
        Effect.gen(function* () {
          // A rehydrate replay still behind its high water must finish before
          // any queued turn reaches the harness: the adapter's present is not
          // yet the harness's present. Waiting inside the permit is safe — the
          // gate resolves from an independent watcher fiber.
          if (entry.gate !== null) yield* Deferred.await(entry.gate);
          // Drain until one turn is accepted or the queue is empty. A rejected turn (bad model,
          // transient send failure) must not strand the turns queued behind it: nothing else
          // re-enters dispatch until the NEXT accepted turn completes.
          for (;;) {
            // A hand-over holds the queue: the waiting turn keeps its place, and so do the turns
            // behind it (decision 6).
            if (
              hosted.get(entry.process.id) !== entry ||
              entry.stopping ||
              entry.steerHolds > 0 ||
              entry.handingOverTo !== null
            )
              return;
            if ((yield* dispatchOne(entry)) === "done") return;
          }
        }),
      );

    /** A caller's dispatch runs in the host's scope: a caller that goes away stops none of it. */
    const dispatchJoined = (entry: HostedProcess): Effect.Effect<void> =>
      Effect.forkIn(dispatchNext(entry), scope).pipe(Effect.flatMap(Fiber.join));

    /**
     * Wait for a hosted process to be quiescent (decision 6): decided, then re-checked once the
     * settle has passed; what holds it is said on every look. A process gone from the host (it
     * ended, or another Mend took it) holds nothing.
     */
    const waitQuiescent = (
      entry: HostedProcess,
      waiting: (quiescence: AgentQuiescence) => Effect.Effect<void>,
      /** Asked on every look: false stops the wait (the waiting turn is gone). */
      stillWanted: Effect.Effect<boolean> = Effect.succeed(true),
      /**
       * A hand-over's wait: the process leaving the host (a takeover detached it, or it ended) is
       * not "quiescent" for it, and the turn keeps its place for the conversation's next process
       * (review 2 of mend#572, P3-1).
       */
      forHandOver = false,
    ): Effect.Effect<WaitOutcome> =>
      Effect.gen(function* () {
        let decided = false;
        /** When this wait first saw each bounded piece of work (`CONVERSATION_WAIT_BOUNDS_MS`). */
        const firstSeen = new Map<string, number>();
        /** When this wait first saw the agent not say what it runs. */
        let unreportedSince: number | null = null;
        for (;;) {
          if (hosted.get(entry.process.id) !== entry) {
            return forHandOver ? WAIT_ABANDONED : { outcome: "quiescent" as const, endedCrons: 0 };
          }
          if (!(yield* stillWanted)) return WAIT_ABANDONED;
          const looked = yield* entry.adapter.quiescence().pipe(Effect.result);
          // A process that went away has nothing left to wait for (it leaves the host); one that
          // could not answer this time is asked again: nothing is stopped on a guess.
          if (looked._tag === "Failure") {
            decided = false;
            yield* Effect.sleep(WAIT_POLL);
            continue;
          }
          const now = yield* Clock.currentTimeMillis;
          // Never a stop on a guess: what the agent would not say is waited for, and then the
          // waiting turn fails with words while the agent goes on (review 2 of mend#572, P2-1).
          // The owner's own takeover of their agent is held by it for as long, no longer.
          if (looked.success.work.some((work) => work.kind === "unknown")) {
            unreportedSince ??= now;
          } else {
            unreportedSince = null;
          }
          const unreportedOver =
            unreportedSince !== null && now - unreportedSince >= CONVERSATION_UNREPORTED_WAIT_MS;
          if (unreportedOver && forHandOver) return { outcome: "cannot-tell", endedCrons: 0 };
          const quiescence = waitedOut(
            unreportedOver
              ? {
                  ...looked.success,
                  work: looked.success.work.filter((work) => work.kind !== "unknown"),
                }
              : looked.success,
            firstSeen,
            now,
          );
          if (quiescence.quiescent) {
            if (decided) {
              // The session crons it no longer waited for end with the process (P3-4).
              const endedCrons = looked.success.work.filter((work) => work.kind === "cron").length;
              return { outcome: "quiescent", endedCrons };
            }
            decided = true;
            yield* Effect.sleep("50 millis");
            continue;
          }
          decided = false;
          yield* waiting(quiescence);
          yield* Effect.sleep(
            quiescence.settleMs > 0 && !quiescence.openTurn && quiescence.work.length === 0
              ? `${Math.max(quiescence.settleMs, 50)} millis`
              : WAIT_POLL,
          );
        }
      });

    /**
     * A queued turn of another sender (or this sender's, once shared control asks for the neutral
     * context): it waits for this process's own work, the waiting line said to both people, then
     * the engine stops this process and starts the conversation's next one (decision 6). A
     * hand-over that fails fails the waiting turn with its words, and the queue goes on here.
     */
    const beginHandOver = (
      entry: HostedProcess,
      turn: AgentTurn,
      sender: string,
      steering: ProtocolSharedControl,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (entry.handingOverTo !== null) return;
        entry.handingOverTo = sender;
        handingOver.set(entry.process.sessionId, entry.process.id);
        /**
         * The waiting turn still waits for this sender: queued, and its decision still a hand-over
         * to them. Withdrawn, cancelled (control turned off, the sender removed), or decided
         * otherwise since, it is not: the queue is freed and nothing is written or started for
         * them (review of mend#572, P2-1).
         */
        const stillWanted = Effect.gen(function* () {
          const now = yield* conversations.byTurnId(turn.id);
          if (now === null || now.status !== "queued") return false;
          const decision = yield* steering.decide(now);
          return decision.kind === "hand-over" && decision.sender === sender;
        });
        const abandon = Effect.gen(function* () {
          entry.handingOverTo = null;
          if (handingOver.get(entry.process.sessionId) === entry.process.id) {
            handingOver.delete(entry.process.sessionId);
          }
          yield* steering.waiting(null);
          if (hosted.get(entry.process.id) === entry) yield* dispatchNext(entry);
        });
        /** The waiting turn fails with these words, and the queue goes on here. */
        const failWaiting = (words: string) =>
          Effect.gen(function* () {
            entry.handingOverTo = null;
            entry.stopping = false;
            if (handingOver.get(entry.process.sessionId) === entry.process.id) {
              handingOver.delete(entry.process.sessionId);
            }
            yield* steering.waiting(null);
            const waiting = yield* conversations.byTurnId(turn.id);
            if (waiting !== null && waiting.status === "queued")
              yield* failTurnAndReport(entry, turn.id, words);
            if (hosted.get(entry.process.id) === entry) yield* dispatchNext(entry);
          });
        yield* Effect.forkIn(
          Effect.gen(function* () {
            // Waits, then hands over; a hand-over that finds at the stop that the turn no longer
            // waits, or that the process is busy again, gives everything back and waits again.
            for (;;) {
              const waited = yield* waitQuiescent(
                entry,
                (quiescence) =>
                  steering.waiting({
                    sessionId: entry.process.sessionId,
                    processId: entry.process.id,
                    turnId: turn.id,
                    runsAs: entry.runsAs,
                    sender,
                    openTurn: quiescence.openTurn,
                    work: quiescence.work,
                  }),
                stillWanted,
                true,
              );
              if (waited.outcome === "cannot-tell")
                return yield* failWaiting(UNREPORTED_WORK_REFUSAL);
              // Once more right before anything is prepared.
              if (waited.outcome === "abandoned" || !(yield* stillWanted)) return yield* abandon;
              yield* steering.waiting(null);
              /**
               * At the stop, after every preparation (review 2 of mend#572, P2-2): the turn still
               * waits for this sender, and the process has opened nothing since (a wakeup, a
               * monitor's event, a goal's turn).
               */
              const stillQuiescent = Effect.gen(function* () {
                if (hosted.get(entry.process.id) !== entry || entry.steerHolds > 0) return false;
                if (!(yield* stillWanted)) return false;
                const looked = yield* entry.adapter.quiescence().pipe(Effect.result);
                if (looked._tag === "Failure") return false;
                const work = looked.success.work.filter((item) => item.kind !== "cron");
                return (
                  entry.steerHolds === 0 &&
                  !looked.success.openTurn &&
                  work.length === 0 &&
                  looked.success.settleMs === 0
                );
              });
              const handed = yield* steering
                .handOver(sender, turn.id, { stillQuiescent, endedCrons: waited.endedCrons })
                .pipe(Effect.result);
              if (handingOver.get(entry.process.sessionId) === entry.process.id) {
                handingOver.delete(entry.process.sessionId);
              }
              if (handed._tag === "Success") return;
              if (
                handed.failure.code === HAND_OVER_NOT_NOW &&
                hosted.get(entry.process.id) === entry
              ) {
                entry.stopping = false;
                handingOver.set(entry.process.sessionId, entry.process.id);
                // A launch can hold the session's gate for a while: look again at the waiting
                // pace, not at the quiescence settle's.
                yield* Effect.sleep(WAIT_POLL);
                continue;
              }
              if (handed.failure.code === HAND_OVER_NOT_NOW) return yield* abandon;
              yield* Effect.logWarning("protocol host: the conversation was not handed over").pipe(
                Effect.annotateLogs({
                  processId: entry.process.id,
                  message: handed.failure.message,
                }),
              );
              return yield* failWaiting(handed.failure.message);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("protocol host: a hand-over ended unexpectedly").pipe(
                Effect.annotateLogs({ processId: entry.process.id, cause: String(cause) }),
              ),
            ),
          ),
          scope,
        );
      });

    /**
     * Records a turn the harness opened on its own. While another turn holds the process it stays
     * parked, unless that turn is a claim no dispatch of this host holds (one left by a dispatch
     * that is gone): that goes back to the queue, and the harness turn takes the process.
     */
    const openHarness = (entry: HostedProcess, harness: HarnessTurn): Effect.Effect<void> =>
      Effect.gen(function* () {
        const opening = yield* conversations.openHarnessTurn(
          entry.process.sessionId,
          entry.process.id,
          harness.providerTurnId,
          harness.reason,
          harness.payer,
        );
        if (opening._tag === "Recorded") {
          if (entry.parked === harness) entry.parked = null;
          // Started after the process was told to stop (a goal, a queued prompt): it ends with
          // the process, under its person (decision 6, "The stop").
          if (entry.stopping && opening.turn.status === "running")
            yield* conversations.completeTurn(
              harness.providerTurnId,
              entry.process.sessionId,
              "interrupted",
              null,
              INTERRUPTED_BY_HAND_OVER,
            );
          return;
        }
        const claim = yield* conversations.unsentClaim(entry.process.id);
        if (
          claim !== null &&
          heldByNoDispatch(claim.attempt) &&
          waitingHarness(entry) === harness
        ) {
          released(
            entry,
            harness,
            yield* conversations.putBackOwn(claimOf(entry, claim.attempt), { harness }),
          );
          return;
        }
        yield* Effect.logWarning(
          "protocol host: the harness opened a turn while another turn holds the process",
        ).pipe(
          Effect.annotateLogs({
            processId: entry.process.id,
            providerTurnId: harness.providerTurnId,
          }),
        );
      });

    const projectEvent = Effect.fn("ProtocolHost.projectEvent")(function* (
      entry: HostedProcess,
      event: AgentEvent,
      position: ProviderEventPosition,
    ) {
      switch (event._tag) {
        case "session.ready":
          if (event.providerSessionId !== null) {
            yield* processes.setProviderSessionId(entry.process.id, event.providerSessionId);
            yield* sessions.setProviderSessionId(entry.process.sessionId, event.providerSessionId);
          }
          return;
        case "turn.started": {
          // Only a dispatch's own send binds a turn: what starts while its answer is out.
          const phase = entry.dispatch;
          if (phase._tag !== "Writing") return;
          const send = phase.send;
          if (send.started !== null) {
            if (send.started !== event.providerTurnId)
              yield* Effect.logWarning(
                "protocol host: a second turn started while a send was out",
              ).pipe(
                Effect.annotateLogs({
                  turnId: phase.turn.id,
                  providerTurnId: event.providerTurnId,
                }),
              );
            return;
          }
          send.started = event.providerTurnId;
          yield* conversations.bindOwnSend(
            claimOf(entry, phase.attempt),
            event.providerTurnId,
            send.payer,
          );
          return;
        }
        case "harness-turn.started": {
          // Nobody sent it: it runs on whatever login the workspace holds, the person's whose
          // process it is in a person-layout executor. Parked first, so that a dispatch freeing
          // the process meanwhile records it in the same move.
          const harness: HarnessTurn = {
            providerTurnId: event.providerTurnId,
            reason: event.reason,
            payer: entry.holds,
          };
          entry.parked = harness;
          yield* openHarness(entry, harness);
          return;
        }
        case "turn.completed":
          yield* settleCompletion(entry, event);
          yield* Effect.forkIn(dispatchNext(entry), scope);
          return;
        case "drain.ended":
          yield* Effect.forkIn(dispatchNext(entry), scope);
          return;
        case "item.updated": {
          const turn = yield* lookupTurn(entry.process.sessionId, event.item.providerTurnId);
          // A background task outlives the turn that started it and keeps reporting there.
          if (turn === null || (turn.status !== "running" && event.item.kind !== "task")) return;
          yield* conversations.upsertItem({
            ...event.item,
            sessionId: entry.process.sessionId,
            processId: entry.process.id,
            turnId: turn.id,
            providerOutputSeq: position.outputSequence,
            providerEventIndex: position.eventIndex,
          });
          return;
        }
        case "content.delta":
          // Adapters also emit an idempotent whole-item update after every delta. Persisting only
          // that update prevents replay from appending the same fragment twice.
          return;
        case "request.opened": {
          const turn = yield* lookupTurn(entry.process.sessionId, event.request.providerTurnId);
          // A request that races turn completion must not re-open after cancelOpenForTurn ran;
          // the adapter's own close/cancel path answers the held response.
          if (turn === null || turn.status !== "running") return;
          yield* conversations.openRequest({
            ...event.request,
            sessionId: entry.process.sessionId,
            processId: entry.process.id,
            turnId: turn.id,
          });
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          return;
        }
        case "request.resolved":
          yield* conversations.resolveProviderRequest(entry.process.id, event.providerRequestId);
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          return;
        case "runtime.warning":
          yield* Effect.logWarning(event.message).pipe(
            Effect.annotateLogs({ processId: entry.process.id, harness: entry.process.harness }),
          );
          return;
        case "runtime.error":
          // A process Mend detached itself (a stop, a hand-over, a relaunch) ends its output
          // because Mend aborted it; whoever detached it settles its turns. A hand-over leaves
          // the queued ones for the conversation's next process (decision 6), which takes them
          // when it attaches, and a sweep here would cancel them first (2026-10-09, e4028ea7).
          if (hosted.get(entry.process.id) !== entry) return;
          hosted.delete(entry.process.id);
          // Close the adapter first: it answers held provider requests and stops the output
          // fiber, so no request.opened can land after the cancel sweep below.
          yield* entry.adapter.close().pipe(Effect.ignore);
          yield* conversations.cancelOpenForProcess(entry.process.id);
          yield* entry.hooks.onRequestChanged(entry.process.sessionId);
          yield* Effect.tryPromise({
            try: () => entry.pipe.close(),
            catch: () => new Error("protocol pipe close failed"),
          }).pipe(Effect.ignore);
          yield* Effect.logError(event.message).pipe(
            Effect.annotateLogs({ processId: entry.process.id, harness: entry.process.harness }),
          );
      }
    });

    /** Every turn queued for the session on another process moves onto `to`. */
    const takeQueuedTurns = (sessionId: SessionId, to: SessionProcessId) =>
      Effect.gen(function* () {
        const queuedOn = new Set(
          (yield* conversations.openTurns(sessionId))
            .filter((turn) => turn.status === "queued" && turn.processId !== to)
            .map((turn) => turn.processId),
        );
        for (const from of queuedOn) yield* conversations.requeueQueuedTurns(from, to);
      });

    const attachInternal = Effect.fn("ProtocolHost.attachInternal")(function* (
      input: AttachProtocolProcessInput,
      rehydrateInput: (AgentRehydrateOptions & { readonly highWater: bigint }) | null,
    ) {
      const abort = new AbortController();
      // Always replay from 0: delta text accumulates in the adapter's in-memory items, so a
      // partial replay would rebuild an item from its tail alone. Replaying everything is
      // idempotent — upsertItem skips positions at or below what a row already carries — and
      // rebuilds the accumulation state exactly. (Today attach only ever runs at process
      // creation; boot ends live protocol rows rather than re-attaching.)
      let currentOutputSequence = 0n;
      let projectedOutputSequence: bigint | null = null;
      let currentEventIndex = 0;
      const output = Stream.fromAsyncIterable(
        input.pipe.output({ from: 0n, signal: abort.signal }),
        (cause) => toPlatformError("output", cause),
      ).pipe(
        // One pipe chunk per stream chunk (fromAsyncIterable emits element-wise); the rechunk
        // pins that so the position mutation stays aligned with the element being handled.
        Stream.rechunk(1),
        Stream.map((chunk) => {
          currentOutputSequence = chunk.sequence;
          currentEventIndex = 0;
          return chunk.data;
        }),
      );
      const transport = {
        send: (bytes: Uint8Array) =>
          Effect.tryPromise({
            try: () => input.pipe.send(bytes),
            catch: (cause) =>
              new AgentProtocolError({
                adapter: input.process.harness === "claude" ? "claude" : "codex",
                operation: "transport.send",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        output: output.pipe(
          Stream.mapError(
            (cause) =>
              new AgentProtocolError({
                adapter: input.process.harness === "claude" ? "claude" : "codex",
                operation: "transport.output",
                message: cause.message,
                cause,
              }),
          ),
        ),
        acknowledgeOutput: () =>
          (rehydrateInput === null ? Effect.void : flushItems).pipe(
            Effect.andThen(
              Effect.sync(() => {
                projectedOutputSequence = currentOutputSequence;
              }),
            ),
          ),
        close: () => Effect.sync(() => abort.abort()),
      };
      let activeEntry: HostedProcess | null = null;
      let flushed = false;
      const pendingEvents: Array<{
        readonly event: AgentEvent;
        readonly position: ProviderEventPosition;
      }> = [];
      // Whole-item snapshots supersede earlier pending snapshots of the same item. Keep
      // decoding while one store write is out, so a long reply cannot queue hundreds of
      // obsolete writes ahead of a steer. There is no debounce: the first write starts now.
      const itemPermit = yield* Semaphore.make(1);
      const pendingItems = new Map<
        string,
        {
          readonly event: Extract<AgentEvent, { readonly _tag: "item.updated" }>;
          readonly position: ProviderEventPosition;
        }
      >();
      let writingItems = false;
      let itemFailure: Cause.Cause<never> | null = null;
      const drainItems: Effect.Effect<void> = Effect.gen(function* () {
        if (itemFailure !== null) return yield* Effect.failCause(itemFailure);
        for (;;) {
          const next = pendingItems.values().next().value;
          if (next === undefined || activeEntry === null) {
            // Clear this before releasing the permit. An enqueue after this check starts
            // another writer rather than leaving its snapshot without a wake.
            writingItems = false;
            return;
          }
          pendingItems.delete(next.event.item.providerItemId);
          yield* projectEvent(activeEntry, next.event, next.position);
        }
      });
      const flushItems = itemPermit.withPermits(1)(drainItems);
      const queueItem = (
        event: Extract<AgentEvent, { readonly _tag: "item.updated" }>,
        position: ProviderEventPosition,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (itemFailure !== null) return yield* Effect.failCause(itemFailure);
          pendingItems.set(event.item.providerItemId, { event, position });
          if (writingItems) return;
          writingItems = true;
          yield* flushItems.pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                itemFailure = cause;
                writingItems = false;
              }),
            ),
            Effect.forkIn(scope),
          );
        });
      const onEvent = (event: AgentEvent): Effect.Effect<void> => {
        const position = {
          outputSequence: currentOutputSequence,
          eventIndex: currentEventIndex,
        } satisfies ProviderEventPosition;
        currentEventIndex += 1;
        // Buffer until the flush below drains the queue: an event landing between
        // `activeEntry = entry` and the drain must not jump ahead of buffered ones.
        if (activeEntry === null || !flushed) {
          return Effect.sync(() => pendingEvents.push({ event, position })).pipe(Effect.asVoid);
        }
        if (event._tag === "item.updated") return queueItem(event, position);
        // Deltas have a whole-item update beside them and are never persisted separately.
        if (event._tag === "content.delta") return Effect.void;
        const entry = activeEntry;
        // Requests, completions and other lifecycle events cannot overtake their items.
        return itemPermit.withPermits(1)(
          drainItems.pipe(Effect.andThen(projectEvent(entry, event, position))),
        );
      };
      // Only Claude replays its controls; Codex acknowledges a steer on the wire.
      const controlJournal =
        input.process.harness === "claude"
          ? {
              recorded: yield* conversations.protocolControls(input.process.id),
              record: (control: AgentControlCheckpoint) =>
                conversations.recordProtocolControl(input.process.id, control).pipe(
                  Effect.mapError(
                    (cause) =>
                      new AgentProtocolError({
                        adapter: "claude",
                        operation: "controlJournal.record",
                        message: cause.message,
                        cause,
                      }),
                  ),
                ),
            }
          : undefined;
      const adapter = yield* adapterFor(input.process.harness)
        .start(transport, {
          cwd: input.cwd,
          providerSessionId: input.process.providerSessionId ?? undefined,
          providerSessionPath: input.resumePath ?? undefined,
          sharedControl: (input.runsAs ?? null) !== null,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          onEvent,
          ...(controlJournal === undefined ? {} : { controlJournal }),
          rehydrate:
            rehydrateInput === null
              ? undefined
              : {
                  replayProviderTurnIds: rehydrateInput.replayProviderTurnIds,
                  resolvedProviderRequestIds: rehydrateInput.resolvedProviderRequestIds,
                },
        })
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => toPlatformError("start", cause)),
        );
      const gate = rehydrateInput === null ? null : yield* Deferred.make<void>();
      const steerGate = rehydrateInput === null ? null : yield* Deferred.make<void>();
      const entry: HostedProcess = {
        process: input.process,
        adapter,
        pipe: input.pipe,
        hooks: input.hooks,
        dispatchPermit: Semaphore.makeUnsafe(1),
        steerPermit: Semaphore.makeUnsafe(1),
        abort,
        flushItems,
        gate,
        steerGate,
        holds: launchLogin(input.runsAs ?? input.launchedWithLoginOf),
        runsAs: input.runsAs ?? null,
        handingOverTo: null,
        stopping: false,
        steerHolds: 0,
        dispatch: { _tag: "Idle" },
        parked: null,
      };
      activeEntry = entry;
      hosted.set(input.process.id, entry);
      // The queue is the conversation's (decision 6): a person's process takes the turns queued
      // for the session on the process it replaces, or while none ran. Hosted first, so a turn
      // submitted from here on queues on it; one that read the old process just before queues
      // there and is moved by its own submit (review of mend#572, P3-1).
      if (entry.runsAs !== null && rehydrateInput === null) {
        if (handingOver.has(input.process.sessionId)) handingOver.delete(input.process.sessionId);
        yield* takeQueuedTurns(input.process.sessionId, input.process.id);
      }
      while (pendingEvents.length > 0) {
        const buffered = pendingEvents.splice(0);
        yield* Effect.forEach(
          buffered,
          ({ event, position }) => projectEvent(entry, event, position),
          { discard: true },
        );
      }
      // Synchronous with the emptiness check above: nothing can enqueue between it and this.
      flushed = true;
      if (rehydrateInput === null || gate === null || steerGate === null) {
        yield* dispatchJoined(entry);
        return;
      }
      // Rehydrate returns immediately; a watcher opens the gate once replay
      // passes the probe-time high water (or the stream ends and the entry is
      // gone), then runs the dispatch every blocked caller queued behind.
      // `currentOutputSequence` advances in the stream's map — another fiber.
      const replayCaughtUp = () => currentOutputSequence >= rehydrateInput.highWater;
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (hosted.get(input.process.id) === entry && !replayCaughtUp()) {
            yield* Effect.sleep("100 millis");
          }
          // The last chunk's projection may still be in flight when the
          // sequence catches up; a short settle keeps dispatch behind it.
          yield* Effect.sleep("50 millis");
          yield* Deferred.succeed(gate, undefined);
          if (hosted.get(input.process.id) === entry) yield* dispatchNext(entry);
        }),
        scope,
      );
      yield* Effect.forkIn(
        openSteerGate(
          steerGate,
          () =>
            projectedOutputSequence !== null && projectedOutputSequence >= rehydrateInput.highWater,
          () => hosted.get(input.process.id) === entry,
        ),
        scope,
      );
    });

    const attach = Effect.fn("ProtocolHost.attach")(function* (input: AttachProtocolProcessInput) {
      yield* attachInternal(input, null);
    });

    const rehydrate = Effect.fn("ProtocolHost.rehydrate")(function* (
      input: RehydrateProtocolProcessInput,
    ) {
      if (hosted.has(input.process.id)) return;
      const turns = yield* conversations.listTurns(input.process.sessionId);
      const processTurns = turns.filter((turn) => turn.processId === input.process.id);
      // A turn dispatched but never acknowledged (the restart landed between the
      // adapter send and setProviderTurnId) cannot be correlated with the
      // replay — fail it honestly rather than guess.
      for (const orphan of processTurns) {
        if (orphan.status !== "running" || orphan.providerTurnId !== null) continue;
        const failed = yield* conversations.failUnconfirmedTurn(orphan.id);
        if (failed !== null) yield* input.hooks.onTurnCompleted(failed);
      }
      // In the order they started, not their ordinals: a turn the harness opened on its own
      // takes the next ordinal while a turn queued before it waits behind it.
      const replayProviderTurnIds = processTurns
        .toSorted(
          (a, b) =>
            (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0) || a.ordinal - b.ordinal,
        )
        .flatMap((turn) => (turn.providerTurnId === null ? [] : [turn.providerTurnId]));
      const requests = yield* conversations.listRequests(input.process.sessionId, false);
      const resolvedProviderRequestIds = new Set(
        requests
          .filter(
            (request) => request.processId === input.process.id && request.status !== "pending",
          )
          .map((request) => request.providerRequestId),
      );
      // A response caught mid-delivery reads `sending` forever; make it answerable again.
      yield* conversations.resetSendingResponses(input.process.id);
      yield* conversations.recoverSendingSteers(input.process.id);
      yield* attachInternal(input, {
        replayProviderTurnIds,
        resolvedProviderRequestIds,
        highWater: input.highWater,
      });
    });

    const placeTurn = Effect.fnUntraced(function* (sessionId: SessionId) {
      const rows = yield* processes.listForSession(sessionId);
      const process = rows.findLast(
        (candidate) =>
          candidate.kind === "agent-protocol" &&
          candidate.exitedAt === null &&
          hosted.has(candidate.id),
      );
      if (process !== undefined) return { _tag: "Hosted", processId: process.id } as const;
      const between = handingOver.get(sessionId);
      return between === undefined ? null : ({ _tag: "Between", processId: between } as const);
    });

    const submitTurn = Effect.fn("ProtocolHost.submitTurn")(function* (
      sessionId: SessionId,
      input: string,
      author: string | null,
      launchCorrelationId: string | null = null,
    ) {
      const place = yield* placeTurn(sessionId);
      if (place === null) return yield* new ProtocolHostNotLiveError({ processId: sessionId });
      // A stop that began after the host was read above is not raced: the idle stop's claim and
      // this admission take the same lock, and a claimed session refuses the turn. The next
      // message resumes the session instead.
      const turn = yield* conversations
        .submitTurn(sessionId, place.processId, input, author, launchCorrelationId)
        .pipe(
          Effect.catchTag("SessionStoppingError", () =>
            Effect.fail(new ProtocolHostNotLiveError({ processId: place.processId })),
          ),
        );
      const dispatched = yield* dispatchAdmitted(sessionId, place, dispatchJoined).pipe(
        Effect.exit,
      );
      // From here the answer is read until storage answers: a failure answered for a stored turn
      // tells its sender to send the words again.
      const withdraw = retried(
        Effect.suspend(() => conversations.withdrawMessageTurn(turn.id, place.processId)),
        "protocol host: a turn was not withdrawn",
        { turnId: turn.id },
      );
      if (Exit.isFailure(dispatched)) {
        if (Cause.hasInterruptsOnly(dispatched.cause))
          return yield* Effect.failCause(dispatched.cause);
        // A turn still queued here is withdrawn, so the failure the caller sees is the whole
        // outcome. One a successor or another dispatch took is answered as it stands, never as a
        // failure the caller would send again.
        if (yield* withdraw) return yield* Effect.failCause(dispatched.cause);
        const now = yield* retried(
          Effect.suspend(() => conversations.byTurnId(turn.id)),
          "protocol host: a turn's outcome was not read",
          { turnId: turn.id },
        );
        if (now === null) return yield* Effect.failCause(dispatched.cause);
        return now;
      }
      if (!dispatched.value && (yield* withdraw))
        return yield* new ProtocolHostNotLiveError({ processId: place.processId });
      return turn;
    });

    /**
     * Dispatches a turn admitted at `place` on the process that holds the conversation now: its
     * own, or the one that replaced it, which takes it first. False when no process will take it.
     */
    const dispatchAdmitted = (
      sessionId: SessionId,
      place: { readonly processId: SessionProcessId },
      dispatch: (entry: HostedProcess) => Effect.Effect<void>,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const entry =
          hosted.get(place.processId) ??
          [...hosted.values()].findLast((candidate) => candidate.process.sessionId === sessionId);
        if (entry === undefined) return handingOver.has(sessionId);
        if (entry.process.id !== place.processId)
          yield* takeQueuedTurns(sessionId, entry.process.id);
        yield* dispatch(entry);
        return true;
      });

    const carrySteer = Effect.fn("ProtocolHost.carrySteer")(function* (
      steer: AgentTurnSteer,
      reason: TurnSteerQueueReason,
    ) {
      const place = yield* placeTurn(steer.sessionId);
      const receipt = yield* conversations.queueTurnSteer(
        steer.id,
        place?.processId ?? null,
        reason,
      );
      if (receipt.delivery._tag !== "Queued" || place === null) return receipt;
      const live = yield* dispatchAdmitted(steer.sessionId, place, (entry) =>
        Effect.forkIn(dispatchNext(entry), scope).pipe(Effect.asVoid),
      );
      return live ? receipt : yield* conversations.withdrawTurnSteer(steer.id, place.processId);
    });

    const { steerTurn, steerMessage } = makeTurnSteering({
      conversations,
      hosted: (processId) => hosted.get(processId),
      requireLive: (turn, needs) =>
        placeTurn(turn.sessionId).pipe(
          Effect.flatMap((place) =>
            place === null || (needs === "hosted" && place._tag !== "Hosted")
              ? Effect.fail(new ProtocolHostNotLiveError({ processId: turn.processId }))
              : Effect.void,
          ),
        ),
      carryToNextTurn: carrySteer,
      released: (entry) =>
        hosted.get(entry.process.id) === entry
          ? Effect.forkIn(dispatchNext(entry), scope).pipe(Effect.asVoid)
          : Effect.void,
      scope,
    });

    const sendTurnMessage = Effect.fn("ProtocolHost.sendTurnMessage")(function* (
      input: SendMessageInput,
      reason: MessageTurnReason,
    ) {
      const place = yield* placeTurn(input.sessionId);
      if (place === null)
        return yield* new ProtocolHostNotLiveError({ processId: input.sessionId });
      const admitted = yield* conversations.admitTurnMessage(input, place.processId, reason);
      if (admitted._tag === "Replay") return admitted.result;
      const { turn, messageId } = admitted.result;
      const dispatched = yield* dispatchAdmitted(input.sessionId, place, dispatchJoined).pipe(
        Effect.exit,
      );
      // From here the receipt is read until storage answers: a failure answered for a stored
      // message tells its sender to send the words again.
      const withdraw = retried(
        Effect.suspend(() => conversations.withdrawMessageTurn(turn.id, place.processId)),
        "protocol host: a message's turn was not withdrawn",
        { turnId: turn.id },
      );
      const receipt = retried(
        Effect.suspend(() => conversations.messageById(messageId)),
        "protocol host: a message's receipt was not read",
        { turnId: turn.id },
      );
      if (Exit.isSuccess(dispatched)) {
        if (!dispatched.value) yield* withdraw;
        return yield* receipt;
      }
      if (Cause.hasInterruptsOnly(dispatched.cause))
        return yield* Effect.failCause(dispatched.cause);
      yield* Effect.logError("protocol host: a message's turn was not dispatched").pipe(
        Effect.annotateLogs({ turnId: turn.id, failure: failureName(dispatched.cause) }),
      );
      // Withdrawn, the receipt says not sent. Otherwise another dispatch took the turn, and the
      // receipt says what became of it: never a failure the sender would send again.
      yield* withdraw;
      return yield* receipt;
    });

    const sendMessage = Effect.fn("ProtocolHost.sendMessage")(function* (
      input: SendMessageInput,
      choice: MessageChoice,
    ) {
      const steered =
        choice._tag === "Steer"
          ? steerMessage(input, choice.turnId).pipe(
              Effect.catchTags({
                AgentTurnNotFoundError: () => sendTurnMessage(input, "no-own-running-turn"),
                TurnSteerForbiddenError: () => sendTurnMessage(input, "no-own-running-turn"),
              }),
            )
          : sendTurnMessage(input, choice.reason);
      return yield* steered.pipe(
        Effect.catchTag("SessionStoppingError", () =>
          Effect.fail(new ProtocolHostNotLiveError({ processId: input.sessionId })),
        ),
      );
    });

    const interruptTurn = Effect.fn("ProtocolHost.interruptTurn")(function* (turnId: AgentTurnId) {
      const turn = yield* conversations.byTurnId(turnId);
      if (turn === null) return yield* new ProtocolHostNotLiveError({ processId: turnId });
      // A queued turn never reached the harness: cancel the row and leave the running turn
      // alone. The adapters can only interrupt their current turn, so reaching them for a
      // queued or already-ended turn would stop the wrong work.
      if (turn.status === "queued") {
        yield* conversations.cancelOpenForTurn(turn.id);
        const entry = hosted.get(turn.processId);
        if (entry !== undefined) yield* entry.hooks.onRequestChanged(turn.sessionId);
        return;
      }
      if (turn.status !== "running") return;
      const entry = hosted.get(turn.processId);
      if (entry === undefined) {
        return yield* new ProtocolHostNotLiveError({ processId: turn.processId });
      }
      yield* entry.adapter
        .interrupt()
        .pipe(Effect.mapError(() => new ProtocolHostNotLiveError({ processId: turn.processId })));
    });

    const respondRequest = Effect.fn("ProtocolHost.respondRequest")(function* (
      request: AgentRequest,
      response:
        | { readonly decision: AgentApprovalDecision; readonly answers?: never }
        | { readonly answers: AgentInputAnswers; readonly decision?: never },
      decidedBy: string,
    ) {
      const entry = hosted.get(request.processId);
      if (entry === undefined) {
        return yield* new ProtocolHostNotLiveError({ processId: request.processId });
      }
      yield* conversations.prepareRequestResponse(request.id, response, decidedBy);
      const sendResponse =
        "decision" in response
          ? entry.adapter.respond(request.providerRequestId, response.decision)
          : entry.adapter.respondInput(request.providerRequestId, response.answers);
      yield* sendResponse.pipe(
        Effect.mapError(() => new ProtocolHostNotLiveError({ processId: request.processId })),
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* conversations.failRequestResponse(request.id);
            // The turn may have completed while the send was in flight; its cancel sweep
            // skipped this row (delivery read `sending`). Sweep again now that it reads
            // `failed`, or the pending row pins the session at `waiting` forever.
            const turn = yield* conversations.byTurnId(request.turnId);
            if (turn !== null && turn.status !== "running" && turn.status !== "queued") {
              yield* conversations.cancelOpenForTurn(request.turnId);
            }
            yield* entry.hooks.onRequestChanged(request.sessionId);
          }),
        ),
      );
      const resolved = yield* conversations.completeRequestResponse(request.id);
      yield* entry.hooks.onRequestChanged(request.sessionId);
      return resolved;
    });

    const detach = Effect.fn("ProtocolHost.detach")(function* (processId: SessionProcessId) {
      const entry = hosted.get(processId);
      if (entry === undefined) return;
      hosted.delete(processId);
      yield* entry.adapter.close();
      entry.abort.abort();
      yield* entry.flushItems;
    });

    const quiescence = Effect.fn("ProtocolHost.quiescence")(function* (
      processId: SessionProcessId,
    ) {
      const entry = hosted.get(processId);
      if (entry === undefined) return null;
      return yield* entry.adapter.quiescence().pipe(Effect.orElseSucceed(() => null));
    });

    const awaitQuiescent = (
      processId: SessionProcessId,
      waiting: (quiescence: AgentQuiescence) => Effect.Effect<void> = () => Effect.void,
    ): Effect.Effect<void> => {
      const entry = hosted.get(processId);
      return entry === undefined ? Effect.void : Effect.asVoid(waitQuiescent(entry, waiting));
    };

    const endWork = Effect.fn("ProtocolHost.endWork")(function* (
      processId: SessionProcessId,
      work: Pick<AgentBackgroundWork, "kind" | "id">,
    ) {
      const entry = hosted.get(processId);
      if (entry === undefined) return yield* new ProtocolHostNotLiveError({ processId });
      yield* entry.adapter
        .endWork(work)
        .pipe(Effect.mapError(() => new ProtocolHostNotLiveError({ processId })));
    });

    const detachForHandOver = Effect.fn("ProtocolHost.detachForHandOver")(function* (
      processId: SessionProcessId,
      queueOnConversation = true,
    ) {
      const entry = hosted.get(processId);
      if (entry === undefined) return;
      entry.stopping = true;
      yield* entry.adapter.close();
      entry.abort.abort();
      yield* entry.flushItems;
      if (queueOnConversation) handingOver.set(entry.process.sessionId, processId);
      // A claim no dispatch of this host holds goes back to the queue; one a dispatch holds is
      // that dispatch's to settle, and it sees the stop.
      const claim = yield* conversations.unsentClaim(processId);
      if (claim !== null && heldByNoDispatch(claim.attempt))
        yield* conversations.putBackOwn(claimOf(entry, claim.attempt));
      for (const turn of yield* conversations.openTurns(entry.process.sessionId)) {
        if (turn.processId !== processId || turn.status !== "running") continue;
        if (turn.providerTurnId === null) continue;
        const ended = yield* conversations.completeTurn(
          turn.providerTurnId,
          turn.sessionId,
          "interrupted",
          null,
          INTERRUPTED_BY_HAND_OVER,
        );
        if (ended !== null) yield* entry.hooks.onTurnCompleted(ended);
      }
      yield* detach(processId);
    });

    return ProtocolHost.of({
      attach,
      rehydrate,
      sendMessage,
      submitTurn,
      steerTurn,
      interruptTurn,
      respondRequest,
      detach,
      has: (processId) => Effect.succeed(hosted.has(processId)),
      quiescence,
      awaitQuiescent,
      endWork,
      detachForHandOver,
    });
  }),
);
