import type { AgentApprovalDecision, AgentEvent, AgentInputAnswers } from "@mend/domain/workbench";
import { type Effect, Schema, type Scope, type Stream } from "effect";

/** A protocol adapter could not parse, send, or correlate a provider message. */
export class AgentProtocolError extends Schema.TaggedErrorClass<AgentProtocolError>()(
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
export class AgentTurnBusyError extends Schema.TaggedErrorClass<AgentTurnBusyError>()(
  "AgentTurnBusyError",
  { providerTurnId: Schema.String },
) {}

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
  readonly steering?: boolean | undefined;
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
    | "cron";
  /** The harness's own id: a task id, a thread id, a terminal's process id, a tool use id. */
  readonly id: string;
  readonly description: string | null;
  /**
   * The person the process runs as, or the session's owner, can end it from the waiting line:
   * Claude's task stop, Codex's `thread/backgroundTerminals/terminate` and `thread/goal/clear`. A
   * wakeup or a monitor ends on its own.
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
