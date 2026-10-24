import type { AgentApprovalDecision, AgentEvent, AgentInputAnswers } from "@mend/domain/workbench";
import { type Effect, Schema, type Scope, type Stream } from "effect";

/** A protocol adapter could not parse, send, or correlate a provider message. */
export class AgentProtocolError extends Schema.TaggedError<AgentProtocolError>()(
  "AgentProtocolError",
  {
    adapter: Schema.Literals(["codex", "claude"]),
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The agent is in a turn it started on its own (a background task ended): a turn Mend sends now
 * would land inside it. The turn waits; that turn's end dispatches it.
 */
export class AgentTurnBusyError extends Schema.TaggedError<AgentTurnBusyError>()(
  "AgentTurnBusyError",
  { providerTurnId: Schema.String },
) {}

/** Words for the running turn, delivered into it without starting another. */
export interface AgentSteerInput {
  /** Mend's steer id; Claude puts it on the wire as `uuid`. */
  readonly id: string;
  /** Codex: the provider turn id. Claude: the adapter-minted logical turn id. */
  readonly expectedTurnId: string;
  readonly input: string;
}

/** Delivery evidence, never proof the model read it. */
export type AgentSteerAcceptance =
  /** Codex answered `turn/steer` with the expected turn id. */
  | { readonly _tag: "ProviderAcknowledged"; readonly providerTurnId: string }
  /** Claude acknowledges nothing: the frame reached its stdin. */
  | { readonly _tag: "TransportWritten"; readonly providerTurnId: string };

/** The harness would not take the words; nothing reached the running turn. */
export class AgentSteerRefusedError extends Schema.TaggedError<AgentSteerRefusedError>()(
  "AgentSteerRefusedError",
  {
    adapter: Schema.Literals(["codex", "claude"]),
    reason: Schema.Literals([
      "no-active-turn",
      "target-changed",
      "review-turn",
      "compact-turn",
      "output-schema",
      "invalid-input",
      "server-draining",
      "unsupported",
      "in-continuation",
    ]),
    expectedTurnId: Schema.String,
    actualTurnId: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {}

/** Delivery failed; `certainty` says whether any byte may have reached the harness. */
export class AgentSteerDeliveryError extends Schema.TaggedError<AgentSteerDeliveryError>()(
  "AgentSteerDeliveryError",
  {
    adapter: Schema.Literals(["codex", "claude"]),
    certainty: Schema.Literals(["not-written", "uncertain"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * One steer or interrupt a Claude adapter wrote, or decided not to write, at a point in its
 * output. Rehydrate replays these at the same points, so the replayed turn folds the same way.
 */
export interface AgentControlCheckpoint {
  /** Orders the controls of one process; several can share an output line. */
  readonly ordinal: number;
  /** The steer id, or an adapter-minted id for an interrupt. */
  readonly controlId: string;
  readonly providerTurnId: string;
  /**
   * Non-empty complete NDJSON output lines fully reduced before this control. The output decoder
   * skips blank lines, and live and replay share it, so a position names the same line in both.
   */
  readonly afterOutputLine: number;
  readonly action: "steer-now" | "interrupt" | "not-written";
}

/** Claude recovery data. One writer (the host callback), one reader (adapter rehydrate). */
export interface AgentControlJournal {
  /** Fails, and the control's wire write does not happen. */
  readonly record: (checkpoint: AgentControlCheckpoint) => Effect.Effect<void, AgentProtocolError>;
  /**
   * What `record` stored for this process before a restart, in any order; empty for a new
   * process. A rehydrate folds them at their output lines, and new ordinals continue above them.
   */
  readonly recorded: ReadonlyArray<AgentControlCheckpoint>;
}

/** Byte transport supplied by the session engine from one Sealant pipe session. */
export interface AgentTransport {
  readonly send: (bytes: Uint8Array) => Effect.Effect<void, AgentProtocolError>;
  readonly output: Stream.Stream<Uint8Array, AgentProtocolError>;
  /** Persist the latest fully handled output position when the decoder is at a line boundary. */
  readonly acknowledgeOutput?: (() => Effect.Effect<void, AgentProtocolError>) | undefined;
  readonly close: () => Effect.Effect<void>;
}

/**
 * Boot-time rehydration of a still-running pipe: the harness never observed a
 * disconnect (its stdio terminates at the platform daemon), so the adapter
 * skips any handshake and reconstructs its correlation state by replaying the
 * recorded output from 0 instead.
 */
export interface AgentRehydrateOptions {
  /**
   * Provider turn ids of already-started turns, in the order they started — the ones Mend
   * dispatched and the ones the harness opened itself. Claude turn ids are client-minted and
   * never appear on the wire, so replay correlates results back to turns through this queue;
   * codex carries turn ids in its notifications and ignores it.
   */
  readonly replayProviderTurnIds: ReadonlyArray<string>;
  /**
   * Provider request ids whose durable rows are already resolved. Replay
   * re-encounters their opening lines; the adapter must not re-open or
   * re-answer them.
   */
  readonly resolvedProviderRequestIds: ReadonlySet<string>;
}

/** Shared options used when a provider conversation starts or resumes. */
export interface AgentStartOptions {
  readonly cwd: string;
  readonly providerSessionId?: string | undefined;
  /**
   * The full path of the conversation's file a resume continues (docs/adr/0016, decision 6,
   * "Resume never forks"): Codex resumes `thread/resume { path }`, so a conversation home's
   * thread is never looked up by id in an index that does not hold it.
   */
  readonly providerSessionPath?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly permissionMode: "bypass" | "ask";
  /**
   * The process runs as a person in a shared conversation's workspace (docs/adr/0016, decision 6):
   * Codex asks for the experimental API (`thread/resume { path }`, background terminals, goals),
   * and a Claude rehydrated after a restart is asked for its live background tasks again.
   */
  readonly sharedControl?: boolean | undefined;
  /** Where a Claude adapter records its controls; without one, Claude cannot be steered. */
  readonly controlJournal?: AgentControlJournal | undefined;
  /** Synchronous event projection hook; completion means the event is durable. */
  readonly onEvent?: ((event: AgentEvent) => Effect.Effect<void>) | undefined;
  /** Present only when re-attaching to a surviving pipe after a Mend restart. */
  readonly rehydrate?: AgentRehydrateOptions | undefined;
}

/**
 * One piece of work a protocol agent still has in flight outside a turn (docs/adr/0016, decision
 * 6): what a new sender's turn waits for, and nothing is killed.
 */
export interface AgentBackgroundWork {
  readonly kind:
    | "task"
    | "paused-task"
    | "sub-agent"
    | "terminal"
    | "goal"
    | "wakeup"
    | "monitor"
    | "cron"
    /** The harness would not say (an older Codex refusing a method): waited for, bounded. */
    | "unknown";
  /** The harness's own id: a task id, a thread id, a terminal's process id, a tool use id. */
  readonly id: string;
  readonly description: string | null;
  /**
   * The person the process runs as, or the session's owner, can end it from the waiting line:
   * Claude's task stop (a monitor's too), Codex's `thread/backgroundTerminals/terminate` and
   * `thread/goal/clear`. A wakeup ends on its own; a session cron and what the harness would not
   * say are waited for, bounded (`CONVERSATION_WAIT_BOUNDS_MS`).
   */
  readonly endable: boolean;
}

/** Whether a protocol agent may be stopped for another sender's process (decision 6). */
export interface AgentQuiescence {
  /** No open turn, nothing in the background, and settled. */
  readonly quiescent: boolean;
  /** A turn runs: one Mend sent, or one the harness opened on its own. */
  readonly openTurn: boolean;
  readonly work: ReadonlyArray<AgentBackgroundWork>;
  /**
   * How long, in milliseconds, until the agent counts as settled once nothing else holds it: none
   * for Claude once it reported `session_state_changed: idle`; 1 s after Codex's last
   * `turn/completed` or `item/completed`, since goals, the mailbox and queued prompts start turns
   * on their own after one.
   */
  readonly settleMs: number;
}

/** One live provider conversation over a byte transport. */
export interface AgentSession {
  readonly sendTurn: (
    input: string,
  ) => Effect.Effect<string, AgentProtocolError | AgentTurnBusyError>;
  readonly interrupt: () => Effect.Effect<void, AgentProtocolError>;
  /**
   * Whether `steer` can deliver into a running turn, and whether doing so cancels the tools that
   * turn is running (Claude's `priority: "now"` does; Codex queues the words for its next step).
   */
  readonly activeSteering: { readonly supported: boolean; readonly interruptsTools: boolean };
  /** Deliver words into the running turn `expectedTurnId` names, never starting another. */
  readonly steer: (
    input: AgentSteerInput,
  ) => Effect.Effect<AgentSteerAcceptance, AgentSteerRefusedError | AgentSteerDeliveryError>;
  readonly respond: (
    providerRequestId: string,
    decision: AgentApprovalDecision,
  ) => Effect.Effect<void, AgentProtocolError>;
  readonly respondInput: (
    providerRequestId: string,
    answers: AgentInputAnswers,
  ) => Effect.Effect<void, AgentProtocolError>;
  readonly events: Stream.Stream<AgentEvent>;
  /** What the agent has in flight now (decision 6); Codex asks the app-server. */
  readonly quiescence: () => Effect.Effect<AgentQuiescence, AgentProtocolError>;
  /**
   * Whether the agent can say what it runs in the background (decision 6). Claude always can; a
   * Codex app-server only when it was initialized with `experimentalApi`, which a process started
   * before shared steering was not. One that cannot takes its owner's turns only until it restarts
   * (review 2 of mend#572, P2-1).
   */
  readonly reportsBackgroundWork: () => Effect.Effect<boolean>;
  /** End one piece of background work the waiting line offers (`endable`). */
  readonly endWork: (
    work: Pick<AgentBackgroundWork, "kind" | "id">,
  ) => Effect.Effect<void, AgentProtocolError>;
  readonly close: () => Effect.Effect<void>;
}

/** A provider-specific stdio protocol implementation. */
export interface AgentAdapter {
  readonly start: (
    transport: AgentTransport,
    options: AgentStartOptions,
  ) => Effect.Effect<AgentSession, AgentProtocolError, Scope.Scope>;
}
