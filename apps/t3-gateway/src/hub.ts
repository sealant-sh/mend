import { randomBytes, randomUUID } from "node:crypto";

import {
  EventId,
  OrchestrationProjectShell,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
} from "@mend/t3-contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GatewayConfig } from "./config.ts";
import { gateDeviceCalls, type GatedMend } from "./device-gate.ts";
import { makeFanout, type SubscriberFellBehind } from "./fanout.ts";
import {
  MendClient,
  MendDeviceRefused,
  type MendCommand,
  type MendCommandRefused,
  type MendRequestResponse,
  type MendNotFound,
  type MendUnavailable,
} from "./mend-client.ts";
import type {
  MendActiveSession,
  MendProcess,
  MendConversationWait,
  MendEventPointer,
  MendItem,
  MendProject,
  MendRequest,
  MendSession,
  MendSessionAnnotation,
  MendTurn,
  MendWorkspaceRetirement,
} from "./mend-workbench.ts";
import { readsRetirement, readsWaiting, threadNoticesOf } from "./notices.ts";
import * as Queueing from "./queue.ts";
import {
  makeReplayLog,
  makeSequencer,
  SHELL_REPLAY_LIMITS,
  type SequenceBlock,
  THREAD_REPLAY_LIMITS,
  type ReplayLog,
} from "./replay.ts";
import {
  isProjectable,
  launchingAgentOf,
  PROJECTION_SCHEMA_VERSION,
  projectShellOf,
  threadShellOf,
  type ThreadSource,
  worktreePathOf,
} from "./shell.ts";
import {
  GatewayState,
  type BearerSession,
  type LaunchedThread,
  type ThreadLaunchOptions,
  type TurnIds,
} from "./state.ts";
import { threadProjectionOf } from "./thread-projection.ts";

/**
 * The projection hub (ADR 0012, "Projection"): one per paired person, shared by every socket and
 * request of theirs. It holds one Mend SSE stream, re-reads what each pointer names through Mend's
 * API as that person, rebuilds the t3code entities, diffs them against what it last sent, and
 * stamps each change with its own sequence, from a reservation that no later hub of the person
 * repeats. A client resuming after a sequence the hub still holds gets only what it missed
 * (`replay.ts`); any other gets a fresh snapshot, always a legal reset for a t3code client.
 */

/** A shell change after the snapshot. */
export type ShellDelta = Exclude<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
>;

/** Mend could not be read as the person: their devices are refused, or Mend did not answer. */
export type HubReadError = MendDeviceRefused | MendUnavailable;

/** How much of a branch's name a new worktree's name keeps, before its suffix. */
const WORKTREE_NAME_STEM = 53;
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Six random characters of `[a-z0-9]`: what makes a new worktree's name its own. */
const worktreeSuffix = (): string =>
  Array.from(randomBytes(6), (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join("");

export interface ShellSubscription {
  /**
   * The shell as of subscribing, or, for a client resuming after a sequence the hub still covers,
   * only what changed after it (`replay.ts`). Every later change arrives in `changes`.
   */
  readonly start:
    | { readonly kind: "snapshot"; readonly snapshot: OrchestrationV2ShellSnapshot }
    | { readonly kind: "replay"; readonly deltas: ReadonlyArray<ShellDelta> };
  /** Fails with `SubscriberFellBehind` when the subscriber cannot keep up (`fanout.ts`). */
  readonly changes: Stream.Stream<ShellDelta, SubscriberFellBehind>;
}

/** One thread as of a sequence. */
export interface ThreadSnapshot {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
}

/**
 * A thread change after the snapshot: an entity upsert, or a fresh snapshot when something the
 * client holds went away (a snapshot is a legal reset).
 */
export type ThreadChange =
  | {
      readonly kind: "event";
      readonly sequence: number;
      readonly event: OrchestrationV2DomainEvent;
    }
  | ({ readonly kind: "snapshot" } & ThreadSnapshot);

export interface ThreadSubscription {
  /** The thread in full, or what changed after the sequence the client resumed after. */
  readonly start:
    | { readonly kind: "snapshot"; readonly snapshot: ThreadSnapshot }
    | { readonly kind: "replay"; readonly changes: ReadonlyArray<ThreadChange> };
  /** Fails with `SubscriberFellBehind` when the subscriber cannot keep up (`fanout.ts`). */
  readonly changes: Stream.Stream<ThreadChange, SubscriberFellBehind>;
}

export interface PersonHub {
  /** The shell now, once the hub has read Mend at least once. */
  readonly shellSnapshot: Effect.Effect<OrchestrationV2ShellSnapshot, HubReadError>;
  /**
   * The shell now, or what changed after `afterSequence` when the hub still covers it, and its
   * changes from here, for as long as the scope lasts.
   */
  readonly subscribeShell: (
    afterSequence: number | undefined,
  ) => Effect.Effect<ShellSubscription, HubReadError, Scope.Scope>;
  /** Whether Mend has refused this device token: the device was revoked. */
  readonly isRefused: (token: string) => boolean;
  /** Completes once Mend refuses this device token; a socket holding it closes then. */
  readonly refusal: (token: string) => Effect.Effect<void>;
  /** Mend's client for this person's calls, gated: a 401 refuses the token used. */
  readonly mend: GatedMend;
  /** One thread in full, or null when the person has no such thread. */
  readonly threadSnapshot: (threadId: string) => Effect.Effect<ThreadSnapshot | null, HubReadError>;
  /**
   * One thread in full and its changes from here; the hub keeps its items current while any
   * subscription lasts. Null when the person has no such thread.
   */
  readonly subscribeThread: (
    threadId: string,
    afterSequence?: number,
  ) => Effect.Effect<ThreadSubscription | null, HubReadError, Scope.Scope>;
  /** What a t3code client may do to a thread, each answering the hub's sequence after it. */
  readonly commands: ThreadCommands;
  /**
   * The change of the thread whose worktree is at `worktreePath` (what t3code's review calls its
   * `cwd`), or null when no thread of the person's is there or its worktree has no change yet.
   */
  readonly changeOfWorktree: (
    worktreePath: string,
  ) => Effect.Effect<WorktreeChange | null, HubReadError>;
}

export interface WorktreeChange {
  readonly changeId: string;
  /** The ref the worktree was based on, when Mend recorded one. */
  readonly baseRef: string | null;
}

/** A thread command Mend or the gateway did not take; `authorization` when it is not theirs. */
export class ThreadCommandRefused extends Schema.TaggedError<ThreadCommandRefused>()(
  "ThreadCommandRefused",
  { reason: Schema.String, authorization: Schema.Boolean },
) {
  override get message(): string {
    return this.reason;
  }
}

export type ThreadCommandFailure = ThreadCommandRefused | HubReadError;

export interface ThreadCommands {
  /**
   * A message for the thread. The gateway queues it and sends it once no turn is open: as a turn
   * of the live agent, or, when the agent has stopped (the idle stop), as the opening turn of a
   * protocol launch on the options the session last recorded, so it comes back as it was.
   */
  readonly send: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly commandId: string;
    readonly messageId: string;
    readonly text: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /** Interrupts a running run, or takes back a queued one; `holdQueue` holds what is queued. */
  readonly interrupt: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly runId: string;
    readonly holdQueue: boolean;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  readonly cancelQueued: (
    threadId: string,
    runId: string,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  readonly resumeQueue: (threadId: string) => Effect.Effect<number, ThreadCommandFailure>;
  /** New text for a message still waiting in the gateway's queue (`queued-run.edit`). */
  readonly editQueued: (
    threadId: string,
    runId: string,
    text: string,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  /** Moves a waiting message before another, or last (`queued-run.reorder`). */
  readonly reorderQueued: (
    threadId: string,
    runId: string,
    beforeRunId: string | null,
  ) => Effect.Effect<number, ThreadCommandFailure>;
  readonly respond: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly requestId: string;
    readonly response: MendRequestResponse;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * A new thread (`orchestration.launchThread`): a Mend session the sender owns, in a new
   * worktree or one they join, launched in protocol mode on what the launch names. Its opening
   * message goes through the queue like any other, so it is sent as an exact turn once the agent
   * runs. A retry of the same command is the same thread.
   */
  readonly launch: (input: ThreadLaunch) => Effect.Effect<LaunchedThreadId, ThreadCommandFailure>;
  /** The session's name in Mend (`thread.metadata.update` with a title). Mend lets only its owner. */
  readonly rename: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
    readonly title: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Stops the session (`provider-session.detach`, which t3code sends before a delete): its agent
   * and workspace stop; what is still queued is held, so nothing relaunches it unasked.
   */
  readonly stop: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
  /**
   * Deletes the session in Mend (`thread.delete`), stopping it first when Mend says it is live.
   * Its worktree and change stay, as they do for every session Mend removes.
   */
  readonly remove: (input: {
    readonly session: BearerSession;
    readonly threadId: string;
  }) => Effect.Effect<number, ThreadCommandFailure>;
}

/** Where a launched thread works: a new worktree from a base, or an existing one it joins. */
export type ThreadWorkspace =
  | { readonly kind: "new"; readonly base: string; readonly name: string | null }
  | { readonly kind: "join"; readonly worktreePath: string };

export interface ThreadLaunch {
  readonly session: BearerSession;
  readonly commandId: string;
  /** The client's id for the thread, or null for the session's own. */
  readonly threadId: string | null;
  readonly projectId: string;
  readonly harness: string;
  /** The session's label in Mend, or null to leave it unnamed (named from its first message). */
  readonly label: string | null;
  readonly workspace: ThreadWorkspace;
  readonly options: ThreadLaunchOptions;
  readonly message: { readonly messageId: string; readonly text: string } | null;
}

export interface LaunchedThreadId {
  readonly threadId: string;
  /** The command was launched before: this is that thread. */
  readonly resumed: boolean;
}

/**
 * The person's device tokens the hub reads with: any of them speaks for the same person. A token
 * Mend refuses (a 401, or a revocation the hub checks for) ends everything held with it.
 */
export interface PersonTokens {
  /** A token Mend has not refused yet, or null when every known one was refused. */
  readonly current: () => string | null;
  /** Every token of the person the gateway holds and Mend has not refused. */
  readonly live: () => ReadonlyArray<string>;
  /** Mend refused this token: the device was revoked. Ends its sockets and bearer sessions. */
  readonly refuse: (token: string) => Effect.Effect<void>;
  readonly isRefused: (token: string) => boolean;
  /** Completes once the token is refused. */
  readonly refusal: (token: string) => Effect.Effect<void>;
  /** Completes once every token of the person the gateway holds was refused. */
  readonly noneLeft: Effect.Effect<void>;
}

// ─── State ───────────────────────────────────────────────────────────────────

interface ProjectEntry {
  readonly project: MendProject;
  readonly sessions: ReadonlyArray<MendSession>;
  readonly annotations: ReadonlyMap<string, MendSessionAnnotation>;
}

interface Conversation {
  readonly turns: ReadonlyArray<MendTurn>;
  readonly requests: ReadonlyArray<MendRequest>;
  /** What holds the next sender's turn (docs/adr/0016, decision 6); null when nothing waits. */
  readonly wait: MendConversationWait | null;
}

interface Printed<A> {
  readonly value: A;
  /** The entity as t3code reads it, encoded: what changed, and proof that it encodes. */
  readonly print: string;
}

/** A thread someone is watching: its items, kept current, and what was last sent of it. */
interface Watch {
  count: number;
  /** Counts the times its subscribers all left: only the latest such time's grace may end it. */
  idle: number;
  readonly items: Map<string, MendItem>;
  /** The highest item change-feed cursor read so far. */
  cursor: number;
  /** Entity key → its print as last sent; null until the first subscriber's snapshot. */
  prints: Map<string, string> | null;
  /** The thread as last sent, for the `thread.deleted` event if it goes. */
  thread: OrchestrationV2AppThread | null;
  /** What was published for it since its baseline, for a client resuming after a sequence. */
  log: ReplayLog<ThreadChange> | null;
}

/** A refusal Mend gave a command, in the words t3code shows. */
const commandRefusalOf = (error: MendCommandRefused | MendNotFound): ThreadCommandRefused =>
  error._tag === "MendNotFound"
    ? new ThreadCommandRefused({ reason: error.message, authorization: false })
    : new ThreadCommandRefused({
        reason: error.message,
        authorization: error.status === 403,
      });

/** What a message is told when Mend refused the call that carried it. */
const reasonOf = (error: { readonly _tag: string; readonly message: string }) =>
  error._tag === "MendDeviceRefused"
    ? "Mend no longer accepts the device that sent this message."
    : error.message;

/** How many items one `GET /api/sessions/:id/items` page asks for. */
const ITEM_PAGE = 500;

const EMPTY_CONVERSATION: Conversation = { turns: [], requests: [], wait: null };
const NO_IDS: ReadonlyMap<string, string> = new Map();

/** Encodes through the vendored schema, so a mapping bug is caught here and never sent. */
const printer = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const encode = Schema.encodeUnknownExit(Schema.toCodecJson(schema));
  return (value: S["Type"]): string | Error => {
    const exit = encode(value);
    return Exit.isSuccess(exit) ? JSON.stringify(exit.value) : new Error(String(exit.cause));
  };
};
const printProject = printer(OrchestrationProjectShell);
const printThreadShell = printer(OrchestrationV2ThreadShell);
const printAppThread = printer(OrchestrationV2AppThread);
const printRun = printer(OrchestrationV2Run);
const printRequest = printer(OrchestrationV2RuntimeRequest);
const printMessage = printer(OrchestrationV2ConversationMessage);
const printTurnItem = printer(OrchestrationV2TurnItem);
const printProviderSession = printer(OrchestrationV2ProviderSession);
const printProviderThread = printer(OrchestrationV2ProviderThread);

/** One entity of a thread projection, the event that upserts it, and its print. */
interface ThreadEntity {
  readonly key: string;
  readonly print: string;
  readonly event: (base: {
    readonly id: EventId;
    readonly threadId: ThreadId;
    readonly occurredAt: DateTime.Utc;
  }) => OrchestrationV2DomainEvent;
}

/**
 * A projection's entities, each encoded through its vendored schema. One that does not encode is
 * logged and left out, of the events and of the snapshot alike: a mapping bug never reaches a
 * client as a defect.
 */
const printProjection = (
  projection: OrchestrationV2ThreadProjection,
): Effect.Effect<{
  readonly projection: OrchestrationV2ThreadProjection;
  readonly entities: ReadonlyArray<ThreadEntity>;
}> =>
  Effect.gen(function* () {
    const entities: Array<ThreadEntity> = [];
    const failed = new Set<string>();
    const add = (key: string, print: string | Error, event: ThreadEntity["event"]) => {
      if (print instanceof Error) {
        failed.add(key);
        return Effect.logError("t3 gateway could not encode a thread entity", {
          threadId: projection.thread.id,
          key,
          cause: print.message,
        });
      }
      entities.push({ key, print, event });
      return Effect.void;
    };
    const thread = projection.thread;
    yield* add("thread", printAppThread(thread), (base) => ({
      ...base,
      type: "thread.metadata-updated",
      payload: thread,
    }));
    for (const session of projection.providerSessions) {
      yield* add(`provider-session:${session.id}`, printProviderSession(session), (base) => ({
        ...base,
        type: "provider-session.updated",
        payload: session,
      }));
    }
    for (const providerThread of projection.providerThreads) {
      yield* add(
        `provider-thread:${providerThread.id}`,
        printProviderThread(providerThread),
        (base) => ({ ...base, type: "provider-thread.updated", payload: providerThread }),
      );
    }
    for (const run of projection.runs) {
      yield* add(`run:${run.id}`, printRun(run), (base) => ({
        ...base,
        runId: run.id,
        type: "run.updated",
        payload: run,
      }));
    }
    for (const request of projection.runtimeRequests) {
      yield* add(`request:${request.id}`, printRequest(request), (base) => ({
        ...base,
        type: "runtime-request.updated",
        payload: request,
      }));
    }
    for (const message of projection.messages) {
      yield* add(`message:${message.id}`, printMessage(message), (base) => ({
        ...base,
        type: "message.updated",
        payload: message,
      }));
    }
    for (const item of projection.turnItems) {
      yield* add(`item:${item.id}`, printTurnItem(item), (base) => ({
        ...base,
        type: "turn-item.updated",
        payload: item,
      }));
    }
    if (failed.size === 0) return { projection, entities };
    const kept = <A extends { readonly id: string }>(prefix: string, values: ReadonlyArray<A>) =>
      values.filter((value) => !failed.has(`${prefix}:${value.id}`));
    return {
      projection: {
        ...projection,
        runs: kept("run", projection.runs),
        runtimeRequests: kept("request", projection.runtimeRequests),
        messages: kept("message", projection.messages),
        turnItems: kept("item", projection.turnItems),
        visibleTurnItems: projection.visibleTurnItems
          .filter((row) => !failed.has(`item:${row.item.id}`))
          .map((row, position) => ({ ...row, position })),
      },
      entities,
    };
  });

/**
 * Which pointers move what (`MendEvent` in @mend/db). Record lines (`session-progress`) and
 * review comments change nothing t3code shows; membership and resyncs may move anything.
 */
export const refreshKeyOf = (pointer: MendEventPointer): string | null => {
  switch (pointer.type) {
    case "project":
    case "session":
    case "session-process":
    case "worktree":
    case "session-change":
    case "shared-control-off":
      return pointer.projectId === undefined ? null : `project:${pointer.projectId}`;
    case "agent-conversation":
      return pointer.sessionId === undefined ? null : `conversation:${pointer.sessionId}`;
    // A device revoked, or the account removed from its organization.
    case "user":
      return pointer.facet === "devices" ? "devices" : pointer.facet === "access" ? "all" : null;
    case "organization":
    case "resync":
      return "all";
    default:
      return null;
  }
};

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/** How often every device token of the person is checked against Mend, pointer or not. */
const DEVICE_CHECK_INTERVAL = "60 seconds";
/** How long a failed full read waits before it is tried again. */
const FULL_READ_RETRY = "3 seconds";
/** A stream that lasted this long resets the backoff: it was a drop, not a refusal loop. */
const HEALTHY_STREAM_MS = 30_000;

const projectableSessionIds = (
  entry: ProjectEntry,
  launched: ReadonlyMap<string, LaunchedThread>,
): ReadonlyArray<string> =>
  entry.sessions
    .filter((session) =>
      isProjectable(
        session,
        entry.annotations.get(session.id)?.currentAgent ?? null,
        launched.has(session.id),
      ),
    )
    .map((session) => session.id);

const entryOf = (detail: {
  readonly project: MendProject;
  readonly sessions: ReadonlyArray<MendSession>;
  readonly annotations: ReadonlyArray<MendSessionAnnotation>;
}): ProjectEntry => ({
  project: detail.project,
  sessions: detail.sessions,
  annotations: new Map(detail.annotations.map((annotation) => [annotation.sessionId, annotation])),
});

/**
 * A read that only adds a line (docs/adr/0016, decisions 6 and 13): a server from before it
 * answers 404, and a failed read leaves the line out rather than the thread. A refused device
 * still fails it.
 */
const optionalRead = <A>(
  read: Effect.Effect<A, MendDeviceRefused | MendNotFound | MendUnavailable>,
): Effect.Effect<A | null, MendDeviceRefused> =>
  read.pipe(
    Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
    Effect.catchTag("MendUnavailable", (error) =>
      Effect.logWarning("t3 gateway could not read a line from Mend", {
        cause: error.message,
      }).pipe(Effect.as(null)),
    ),
  );

const mergeItems = (watch: Watch, read: ReadonlyArray<MendItem>) => {
  for (const item of read) {
    const known = watch.items.get(item.id);
    if (known === undefined || known.seq <= item.seq) watch.items.set(item.id, item);
    watch.cursor = Math.max(watch.cursor, item.seq);
  }
};

export const makePersonHub = (input: {
  /** The only way the hub reaches Mend (`device-gate.ts`). */
  readonly mend: GatedMend;
  /**
   * The person the hub reads for: the shared-workspace line names everyone else live in an
   * executor (docs/adr/0016, decision 13). Null reads as someone who runs nothing there.
   */
  readonly viewer: { readonly id: string; readonly name: string } | null;
  readonly state: GatewayState["Service"];
  readonly tokens: PersonTokens;
  /** Lets go of the hub in the registry, once it has torn itself down. */
  readonly dispose?: Effect.Effect<void>;
  /**
   * Holds the hub (true) or lets it go (false) independently of sockets: while a message the
   * gateway accepted is queued or on its way, the hub must outlive every client.
   */
  readonly retain?: (busy: boolean) => Effect.Effect<void>;
  /** The queue's waits (`queue.ts`); Mend-sized defaults when unset. */
  readonly queueTimings?: Queueing.QueueTimings;
}): Effect.Effect<PersonHub, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { mend, state, tokens } = input;
    const retain = input.retain ?? (() => Effect.void);
    const timings = input.queueTimings ?? Queueing.DEFAULT_QUEUE_TIMINGS;
    /** Session id → how many reads of it from Mend were applied: fresh evidence for a retry. */
    const evidence = new Map<string, number>();
    const sawSession = (sessionId: string) =>
      evidence.set(sessionId, (evidence.get(sessionId) ?? 0) + 1);
    const hubScope = yield* Scope.Scope;

    /** Mend session id → the t3code ids of the turns the gateway sent (the id map). */
    const turnIds = new Map<
      string,
      { readonly runIds: Map<string, string>; readonly messageIds: Map<string, string> }
    >();
    const rememberIds = (ids: TurnIds) => {
      const known = turnIds.get(ids.sessionId) ?? { runIds: new Map(), messageIds: new Map() };
      known.runIds.set(ids.turnId, ids.runId);
      known.messageIds.set(ids.turnId, ids.messageId);
      turnIds.set(ids.sessionId, known);
    };
    for (const ids of yield* state
      .listTurnIds()
      .pipe(
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not read its id map", { cause: error.message }).pipe(
            Effect.as<ReadonlyArray<TurnIds>>([]),
          ),
        ),
      )) {
      rememberIds(ids);
    }
    /**
     * Session id → the thread a t3code client launched as it, and the client's thread id → its
     * session: a launched thread keeps the id its client gave it (`thread_ids`).
     */
    const launched = new Map<string, LaunchedThread>();
    const sessionOfThread = new Map<string, string>();
    const rememberThread = (thread: LaunchedThread) => {
      launched.set(thread.sessionId, thread);
      sessionOfThread.set(thread.threadId, thread.sessionId);
    };
    // Only the person's own launches: a client thread id names a session for its launcher alone,
    // and everyone else sees the session by its Mend id.
    const launcher = input.viewer?.id ?? null;
    for (const thread of yield* (
      launcher === null
        ? Effect.succeed<ReadonlyArray<LaunchedThread>>([])
        : state.listThreads(launcher)
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("t3 gateway could not read its thread map", {
          cause: error.message,
        }).pipe(Effect.as<ReadonlyArray<LaunchedThread>>([])),
      ),
    )) {
      rememberThread(thread);
    }
    /** A t3code thread id as the Mend session it is. */
    const sessionIdOf = (threadId: string): string => sessionOfThread.get(threadId) ?? threadId;
    /**
     * Sessions deleted through the gateway that Mend keeps until their workspace has stopped
     * (`RemovalReport.leftover`): hidden at once, as t3code's client already dropped them, and kept
     * in the state file so a restart does not bring them back.
     */
    const removing = new Set<string>(
      launcher === null
        ? []
        : yield* state.listRemovals(launcher).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not read its pending removals", {
                cause: error.message,
              }).pipe(Effect.as<ReadonlyArray<string>>([])),
            ),
          ),
    );
    /** Forgets the removals Mend has finished: it no longer lists the session. */
    const removed = (sessionIds: ReadonlyArray<string>) =>
      launcher === null
        ? Effect.void
        : Effect.forEach(
            sessionIds,
            (sessionId) =>
              state.dropRemoval(launcher, sessionId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("t3 gateway could not forget a finished removal", {
                    cause: error.message,
                  }),
                ),
              ),
            { discard: true },
          );
    /**
     * Sessions just created for a launch that no project read has shown yet: hidden, and their
     * queue left alone, until one does, so the client never sees the thread without its message
     * and the message is never failed as "gone" for a session not read yet.
     */
    const opening = new Set<string>();
    /** A launched session a project read showed: it is a thread from here. */
    const seen = (sessionIds: Iterable<string>) => {
      for (const sessionId of sessionIds) opening.delete(sessionId);
    };
    const queues = new Map<string, Queueing.ThreadQueue>();
    /**
     * Session id → its queue as the state file last kept it (ADR 0012, "State"): a queue is written
     * when it changed, and a restart brings back what was kept for this person.
     */
    const keptQueues = new Map<string, string>();
    const keeper = input.viewer;
    if (keeper !== null) {
      for (const restored of yield* state.loadQueues(keeper.id).pipe(
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not read its kept queues", {
            cause: error.message,
          }).pipe(Effect.as([])),
        ),
      )) {
        const queue = Queueing.restoredQueue(
          restored.queue,
          (sender) => restored.senders.get(sender) ?? null,
        );
        queues.set(restored.sessionId, queue);
        keptQueues.set(restored.sessionId, JSON.stringify(restored.queue));
      }
    }
    /**
     * Messages Mend took whose turn ids the state file refused (review 593-R2-2): each is still
     * kept as being sent, so after a restart it comes back as sent-before-restart and a retry of
     * it is not taken as new. Every later write of the queue tries the ids again first.
     */
    const unrecorded = new Map<
      string,
      Array<{ readonly stored: Queueing.StoredEntry; readonly ids: TurnIds }>
    >();
    const recordUnrecorded = (sessionId: string) =>
      Effect.gen(function* () {
        const waiting = unrecorded.get(sessionId) ?? [];
        const still: typeof waiting = [];
        for (const item of waiting) {
          const recorded = yield* state.recordTurnIds(item.ids, Date.now()).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!recorded) still.push(item);
        }
        if (still.length === 0) unrecorded.delete(sessionId);
        else unrecorded.set(sessionId, still);
        return still.map((item) => item.stored);
      });
    /** Writes one queue if it changed since it was last kept: whether the state file has it now. */
    const keepQueue = (sessionId: string, queue: Queueing.ThreadQueue): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (keeper === null) return true;
        const tombstones = unrecorded.has(sessionId) ? yield* recordUnrecorded(sessionId) : [];
        const live = Queueing.storedOf(queue);
        const stored = { ...live, entries: [...tombstones, ...live.entries] };
        const print = JSON.stringify(stored);
        if (keptQueues.get(sessionId) === print) return true;
        return yield* state.saveQueue(keeper.id, sessionId, stored).pipe(
          Effect.tap(() => Effect.sync(() => keptQueues.set(sessionId, print))),
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("t3 gateway could not keep a queue", { cause: error.message }).pipe(
              Effect.as(false),
            ),
          ),
        );
      });
    /** Writes every queue that changed since it was last kept. */
    const keepQueues = Effect.suspend(() =>
      Effect.forEach(Array.from(queues), ([sessionId, queue]) => keepQueue(sessionId, queue), {
        discard: true,
      }),
    );
    const handledCommands = new Set<string>();

    const projects = new Map<string, ProjectEntry>();
    const conversations = new Map<string, Conversation>();
    /**
     * Session id → the turns Mend answered `POST /turns` with that no read of Mend has shown yet. A
     * read that started before Mend took the turn can land after it was adopted; applied as it is,
     * it would drop the turn, and the queue would send the next message while this one runs.
     */
    const adoptedTurns = new Map<string, Map<string, MendTurn>>();
    /** A conversation as read, with the adopted turns it does not show yet; one it shows is let go. */
    const withAdopted = (sessionId: string, conversation: Conversation): Conversation => {
      const adopted = adoptedTurns.get(sessionId);
      if (adopted === undefined) return conversation;
      const missing: Array<MendTurn> = [];
      for (const [turnId, turn] of adopted) {
        if (conversation.turns.some((known) => known.id === turnId)) adopted.delete(turnId);
        else missing.push(turn);
      }
      if (adopted.size === 0) adoptedTurns.delete(sessionId);
      return missing.length === 0
        ? conversation
        : { ...conversation, turns: [...conversation.turns, ...missing] };
    };
    /**
     * Session id → its row of `GET /api/sessions` (docs/adr/0016, decisions 6, 13 and 14): the
     * people live in its executor, whether control is shared, whether its executor waits to be
     * replaced. The project read's sessions carry none of it. What it says decides whether the
     * waiting line and the retirement are read at all (`readsWaiting`, `readsRetirement`).
     */
    let active = new Map<string, MendActiveSession>();
    /**
     * Session id → its executor's retirement (decision 14), read only for watched threads whose
     * row says one is under way: only the full thread has a place to say it.
     */
    const retirements = new Map<string, MendWorkspaceRetirement | null>();
    /**
     * The hub's sequences come in blocks reserved from the state file (`reserveSequences`): one
     * high-water mark for the whole gateway, seeded from the clock, so no hub ever stamps a
     * sequence a client was given by another (an earlier hub of this person's, another person's,
     * or a gateway before replay, which counted from 0). A resume is answered by replay only after
     * a sequence in one of this hub's blocks. Without a reservation, nothing is replayed.
     */
    const reserveBlock = (from: number) =>
      state.reserveSequences(from, SEQUENCE_BLOCK).pipe(
        Effect.map((start): SequenceBlock => ({ start, end: start + SEQUENCE_BLOCK })),
        Effect.catch((error) =>
          Effect.logError("t3 gateway could not reserve sequences", {
            cause: error.message,
          }).pipe(Effect.as(null)),
        ),
      );
    const sequencer = makeSequencer(input.viewer === null ? null : yield* reserveBlock(0));
    let sequence = sequencer.current();
    /** The next sequence: the next in this block, or the first of the next one. */
    const nextSequence = (): number => {
      sequence = sequencer.next();
      return sequence;
    };
    /** Reserves the next block once half of this one is used, and says when it could not. */
    const extendSequences = Effect.suspend(() => {
      if (sequencer.overran()) {
        return Effect.logError(
          "t3 gateway ran out of reserved sequences: resumes get a snapshot until the hub restarts",
        );
      }
      const from = sequencer.wants();
      if (from === null) return Effect.void;
      return reserveBlock(from).pipe(
        Effect.tap((block) =>
          Effect.sync(() => {
            if (block !== null) sequencer.add(block);
          }),
        ),
        Effect.asVoid,
      );
    });
    const shellLog = makeReplayLog<ShellDelta>(SHELL_REPLAY_LIMITS, sequence);
    let shellProjects = new Map<string, Printed<OrchestrationProjectShell>>();
    let shellThreads = new Map<string, Printed<OrchestrationV2ThreadShell>>();
    const shellChanges = makeFanout<ShellDelta>();
    const watches = new Map<string, Watch>();
    const threadChanges = makeFanout<{
      readonly threadId: string;
      readonly change: ThreadChange;
    }>();
    /** Every read of state and every publication happens under it, in order. */
    const lock = Semaphore.makeUnsafe(1);
    const locked = lock.withPermits(1);
    /** Set once every device of the person was refused: nothing reads Mend for them any more. */
    let dead = false;

    /** Calls Mend with one of the person's tokens, and with another when Mend refuses it. */
    const asPerson = <A, E>(
      call: (token: string) => Effect.Effect<A, E | MendDeviceRefused>,
    ): Effect.Effect<A, E | MendDeviceRefused> =>
      Effect.suspend(() => {
        const token = tokens.current();
        if (token === null) {
          return Effect.fail(new MendDeviceRefused({ operation: "every paired device" }));
        }
        // The gate refused the token on a 401; another of the person's devices may still read.
        return call(token).pipe(
          Effect.catch((error) =>
            error instanceof MendDeviceRefused && tokens.current() !== null
              ? asPerson(call)
              : Effect.fail(error),
          ),
        );
      });

    // ─── Building ──────────────────────────────────────────────────────────

    /** Account id → name: the person who paired, and everyone live anywhere they can see. */
    const knownNames = (): ReadonlyMap<string, string> => {
      const names = new Map<string, string>();
      for (const session of active.values()) {
        for (const person of session.livePeople ?? []) names.set(person.accountId, person.name);
      }
      if (input.viewer !== null) names.set(input.viewer.id, input.viewer.name);
      return names;
    };

    const threadSources = (): ReadonlyArray<ThreadSource> => {
      const sources: Array<ThreadSource> = [];
      const names = knownNames();
      for (const entry of projects.values()) {
        for (const session of entry.sessions) {
          if (removing.has(session.id) || opening.has(session.id)) continue;
          const annotation = entry.annotations.get(session.id);
          const thread = launched.get(session.id);
          const current = annotation?.currentAgent ?? null;
          if (!isProjectable(session, current, thread !== undefined)) continue;
          const agent = current ?? launchingAgentOf(session, thread?.options ?? {});
          const conversation = conversations.get(session.id) ?? EMPTY_CONVERSATION;
          const ids = turnIds.get(session.id);
          const queue = queues.get(session.id);
          sources.push({
            threadId: ThreadId.make(thread?.threadId ?? session.id),
            project: entry.project,
            session,
            agent,
            changeId: annotation?.changeId ?? null,
            turns: conversation.turns,
            requests: conversation.requests,
            runIds: ids?.runIds ?? NO_IDS,
            messageIds: ids?.messageIds ?? NO_IDS,
            pending: (queue?.entries ?? []).map((queued) => ({
              runId: queued.runId,
              messageId: queued.messageId,
              text: queued.text,
              requestedAt: queued.requestedAt,
              state: Queueing.pendingStateOf(queued),
              error: queued.error,
            })),
            queueHeld: queue?.held ?? false,
            notices: threadNoticesOf({
              livePeople: active.get(session.id)?.livePeople ?? [],
              viewerId: input.viewer?.id ?? null,
              wait: conversation.wait,
              retirement: retirements.get(session.id) ?? null,
              names,
            }),
          });
        }
      }
      return sources;
    };

    const sourceOf = (sessionId: string): ThreadSource | null =>
      threadSources().find((source) => source.session.id === sessionId) ?? null;

    const itemsOf = (sessionId: string): ReadonlyArray<MendItem> =>
      Array.from(watches.get(sessionId)?.items.values() ?? []);

    // ─── Publishing ────────────────────────────────────────────────────────

    /** Diffs the shell against what was last sent and publishes the changes, sequenced. */
    const publishShell = Effect.gen(function* () {
      const deltas: Array<ShellDelta> = [];
      /** Each delta's encoded size, for the replay log's budget. */
      const sizes: Array<number> = [];
      const nextProjects = new Map<string, Printed<OrchestrationProjectShell>>();
      for (const entry of projects.values()) {
        const value = projectShellOf(entry.project);
        const print = printProject(value);
        if (print instanceof Error) {
          yield* Effect.logError("t3 gateway could not encode a project", {
            projectId: entry.project.id,
            cause: print.message,
          });
          continue;
        }
        nextProjects.set(value.id, { value, print });
      }
      const nextThreads = new Map<string, Printed<OrchestrationV2ThreadShell>>();
      for (const source of threadSources()) {
        const value = threadShellOf(source, {
          itemCount: source.turns.length,
          visibleItemCount: source.turns.length,
        });
        const print = printThreadShell(value);
        if (print instanceof Error) {
          yield* Effect.logError("t3 gateway could not encode a thread", {
            sessionId: source.session.id,
            cause: print.message,
          });
          continue;
        }
        nextThreads.set(value.id, { value, print });
      }

      for (const [id, next] of nextProjects) {
        if (shellProjects.get(id)?.print === next.print) continue;
        deltas.push({ kind: "project.updated", sequence: nextSequence(), project: next.value });
        sizes.push(replayBytes(next.print));
      }
      for (const [id, next] of nextThreads) {
        if (shellThreads.get(id)?.print === next.print) continue;
        deltas.push({
          kind: "thread.updated",
          sequence: nextSequence(),
          location: "active",
          thread: next.value,
        });
        sizes.push(replayBytes(next.print));
      }
      for (const [id, previous] of shellThreads) {
        if (nextThreads.has(id)) continue;
        deltas.push({
          kind: "thread.removed",
          sequence: nextSequence(),
          location: "active",
          threadId: previous.value.id,
        });
        sizes.push(REMOVAL_BYTES);
      }
      for (const [id, previous] of shellProjects) {
        if (nextProjects.has(id)) continue;
        deltas.push({
          kind: "project.removed",
          sequence: nextSequence(),
          projectId: previous.value.id,
        });
        sizes.push(REMOVAL_BYTES);
      }
      shellProjects = nextProjects;
      shellThreads = nextThreads;
      deltas.forEach((delta, index) => shellLog.push(delta.sequence, delta, sizes[index] ?? 0));
      if (deltas.length > 0) yield* shellChanges.publish(deltas);
    });

    const currentShell = (): OrchestrationV2ShellSnapshot => ({
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      snapshotSequence: sequence,
      projects: Array.from(shellProjects.values(), (printed) => printed.value),
      threads: Array.from(shellThreads.values(), (printed) => printed.value),
      archivedThreads: [],
    });

    const eventBase = () => ({
      id: EventId.make(`event:${nextSequence()}`),
      occurredAt: DateTime.makeUnsafe(Date.now()),
    });

    /**
     * Diffs one watched thread against what was last sent and publishes its changes, sequenced.
     * The first time, nothing has been sent: what is built is the baseline the first subscriber's
     * snapshot shows. Returns the thread as it stands, or null once it is gone.
     */
    const publishThread = (sessionId: string) =>
      Effect.gen(function* () {
        const watch = watches.get(sessionId);
        /** Publishes the thread's changes, and keeps them for a client that resumes. */
        const publish = (changes: ReadonlyArray<readonly [ThreadChange, number]>) => {
          for (const [change, bytes] of changes) {
            watch?.log?.push(
              change.kind === "event" ? change.sequence : change.snapshotSequence,
              change,
              bytes,
            );
          }
          return threadChanges.publish(
            changes.map(([change]) => ({ threadId: sessionId, change })),
          );
        };
        const source = sourceOf(sessionId);
        if (source === null) {
          if (watch?.prints !== null && watch?.thread !== null && watch !== undefined) {
            const base = eventBase();
            const thread = watch.thread;
            yield* publish([
              [
                {
                  kind: "event",
                  sequence,
                  event: {
                    ...base,
                    threadId: thread.id,
                    type: "thread.deleted",
                    payload: { ...thread, deletedAt: base.occurredAt },
                  },
                },
                REMOVAL_BYTES,
              ],
            ]);
            watch.prints = null;
            watch.thread = null;
            watch.log = null;
          }
          return null;
        }
        const built = yield* printProjection(threadProjectionOf(source, itemsOf(sessionId)));
        if (watch === undefined) return built.projection;
        const previous = watch.prints;
        const prints = new Map(built.entities.map((entity) => [entity.key, entity.print]));
        watch.prints = prints;
        watch.thread = built.projection.thread;
        // The baseline a first subscriber's snapshot shows: what follows it is kept for replay.
        if (previous === null) {
          watch.log = sequencer.owns(sequence)
            ? makeReplayLog(THREAD_REPLAY_LIMITS, sequence)
            : null;
          return built.projection;
        }

        // Something the client holds went away: a fresh snapshot replaces it.
        if (Array.from(previous.keys()).some((key) => !prints.has(key))) {
          yield* publish([
            [
              { kind: "snapshot", snapshotSequence: nextSequence(), projection: built.projection },
              built.entities.reduce((total, entity) => total + replayBytes(entity.print), 0),
            ],
          ]);
          return built.projection;
        }
        const changes: Array<readonly [ThreadChange, number]> = [];
        for (const entity of built.entities) {
          if (previous.get(entity.key) === entity.print) continue;
          const base = eventBase();
          changes.push([
            {
              kind: "event",
              sequence,
              event: entity.event({ ...base, threadId: built.projection.thread.id }),
            },
            replayBytes(entity.print),
          ]);
        }
        if (changes.length > 0) yield* publish(changes);
        return built.projection;
      });

    /** Every watched thread, after a read that may have moved any of them. */
    const publishThreads = Effect.suspend(() =>
      Effect.forEach(Array.from(watches.keys()), publishThread, { discard: true }),
    );

    /** Moves every queue on after a read (set below, once the queue's machinery exists). */
    let settleQueues: Effect.Effect<void> = Effect.void;
    /** Whether a message the gateway accepted can still reach Mend: what holds the hub alive. */
    let busy = false;
    const holdWhileBusy = Effect.suspend(() => {
      const now = !dead && Queueing.anyProgress(queues.values());
      if (now === busy) return Effect.void;
      busy = now;
      return retain(now);
    });
    const publishAll = Effect.suspend(() => settleQueues).pipe(
      Effect.andThen(keepQueues),
      Effect.andThen(publishShell),
      Effect.andThen(publishThreads),
      Effect.andThen(extendSequences),
      Effect.andThen(holdWhileBusy),
    );

    // ─── Reading Mend ──────────────────────────────────────────────────────

    /** Every item whose change-feed cursor is past `after`, page by page. */
    const readItemsAfter = (sessionId: string, after: number) =>
      Effect.gen(function* () {
        const read: Array<MendItem> = [];
        let cursor = after;
        for (;;) {
          const page = yield* asPerson((token) =>
            mend.listItems(token, sessionId, cursor, ITEM_PAGE),
          );
          read.push(...page);
          if (page.length < ITEM_PAGE) return read;
          cursor = page.reduce((highest, item) => Math.max(highest, item.seq), cursor);
        }
      }).pipe(
        Effect.catchTag(
          "MendNotFound",
          (): Effect.Effect<ReadonlyArray<MendItem>> => Effect.succeed([]),
        ),
      );

    /**
     * What holds the session's next turn; read only while `readsWaiting` (someone live in its
     * executor, control shared), null otherwise without asking Mend.
     */
    const readWait = (sessionId: string, facts: ReadonlyMap<string, MendActiveSession>) =>
      readsWaiting(facts.get(sessionId))
        ? optionalRead(asPerson((token) => mend.conversationWait(token, sessionId)))
        : Effect.succeed(null);

    const readConversation = (sessionId: string, facts: ReadonlyMap<string, MendActiveSession>) =>
      Effect.all(
        {
          turns: asPerson((token) => mend.listTurns(token, sessionId)),
          requests: asPerson((token) => mend.listRequests(token, sessionId)),
          wait: readWait(sessionId, facts),
        },
        { concurrency: 3 },
      ).pipe(
        Effect.map((conversation): Conversation | null => conversation),
        // The session went between the list and this read; the next project read drops it.
        Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
      );

    const readConversations = (
      sessionIds: ReadonlyArray<string>,
      facts: ReadonlyMap<string, MendActiveSession>,
    ) =>
      Effect.forEach(
        sessionIds,
        (sessionId) =>
          readConversation(sessionId, facts).pipe(
            Effect.map((conversation) => [sessionId, conversation] as const),
          ),
        { concurrency: 4 },
      );

    /**
     * Each live session's row (`GET /api/sessions`): who is live in its executor, whether control
     * is shared, whether its executor waits to be replaced. Null when Mend did not say.
     */
    const readActive = optionalRead(asPerson((token) => mend.listActiveSessions(token))).pipe(
      Effect.map((sessions) =>
        sessions === null
          ? null
          : new Map(sessions.map((session) => [session.id, session] as const)),
      ),
    );

    /**
     * The retirement of each watched thread among `sessionIds`: read only where its row says one is
     * under way (`readsRetirement`), null elsewhere without asking Mend; undefined where Mend did
     * not say.
     */
    const readRetirements = (
      sessionIds: ReadonlyArray<string>,
      facts: ReadonlyMap<string, MendActiveSession>,
    ) =>
      Effect.forEach(
        sessionIds.filter((sessionId) => watches.has(sessionId)),
        (sessionId) =>
          (readsRetirement(facts.get(sessionId))
            ? asPerson((token) => mend.workspaceRetirement(token, sessionId)).pipe(
                Effect.map((retirement): MendWorkspaceRetirement | null | undefined => retirement),
                Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
                Effect.catchTag("MendUnavailable", () => Effect.succeed(undefined)),
              )
            : Effect.succeed(null)
          ).pipe(Effect.map((retirement) => [sessionId, retirement] as const)),
        { concurrency: 4 },
      );

    const applyRetirements = (
      read: ReadonlyArray<readonly [string, MendWorkspaceRetirement | null | undefined]>,
    ) => {
      for (const [sessionId, retirement] of read) {
        if (retirement !== undefined) retirements.set(sessionId, retirement);
      }
      for (const sessionId of retirements.keys()) {
        if (!watches.has(sessionId)) retirements.delete(sessionId);
      }
    };

    /** Everything again: every project the person sees, and every thread's turns and requests. */
    const refreshAll: Effect.Effect<void, HubReadError> = Effect.gen(function* () {
      const listed = yield* asPerson((token) => mend.listProjects(token)).pipe(
        Effect.catchTag(
          "MendNotFound",
          (): Effect.Effect<ReadonlyArray<MendProject>> => Effect.succeed([]),
        ),
      );
      const [details, people] = yield* Effect.all(
        [
          Effect.forEach(
            listed,
            (project) =>
              asPerson((token) => mend.projectDetail(token, project.id)).pipe(
                Effect.map(entryOf),
                Effect.catchTag("MendNotFound", (_: MendNotFound) => Effect.succeed(null)),
              ),
            { concurrency: 4 },
          ),
          readActive,
        ],
        { concurrency: 2 },
      );
      const facts = people ?? active;
      const entries = details.filter((entry): entry is ProjectEntry => entry !== null);
      const sessionIds = entries.flatMap((entry) => projectableSessionIds(entry, launched));
      const [read, retired] = yield* Effect.all(
        [readConversations(sessionIds, facts), readRetirements(sessionIds, facts)],
        { concurrency: 2 },
      );
      // A watched thread's items that moved while pointers could be missed (a reconnect).
      const caughtUp = yield* Effect.forEach(
        Array.from(watches, ([sessionId, watch]) => [sessionId, watch.cursor] as const),
        ([sessionId, cursor]) =>
          readItemsAfter(sessionId, cursor).pipe(
            Effect.map((items) => [sessionId, items] as const),
          ),
        { concurrency: 4 },
      );
      yield* locked(
        Effect.gen(function* () {
          projects.clear();
          for (const entry of entries) projects.set(entry.project.id, entry);
          const present = new Set(entries.flatMap((entry) => entry.sessions.map((s) => s.id)));
          seen(present);
          const finished = Array.from(removing).filter((sessionId) => !present.has(sessionId));
          for (const sessionId of finished) removing.delete(sessionId);
          yield* removed(finished);
          active = facts;
          applyRetirements(retired);
          conversations.clear();
          for (const [sessionId, conversation] of read) {
            if (conversation !== null) {
              conversations.set(sessionId, withAdopted(sessionId, conversation));
            }
          }
          for (const [sessionId, items] of caughtUp) {
            const watch = watches.get(sessionId);
            if (watch !== undefined) mergeItems(watch, items);
          }
          for (const entry of entries) {
            for (const session of entry.sessions) sawSession(session.id);
          }
          yield* publishAll;
        }),
      );
    });

    /** One project again, and the turns of any thread that is new in it. */
    /**
     * `applied` runs with what was read, under the lock and before anything is published: a
     * launched thread's opening message joins its queue in the same publication as its session.
     */
    const refreshProject = (
      projectId: string,
      applied: () => void = () => {},
    ): Effect.Effect<void, HubReadError> =>
      Effect.gen(function* () {
        // A process starting or ending re-reads the project: who is live in each executor with it.
        const [entry, people] = yield* Effect.all(
          [
            asPerson((token) => mend.projectDetail(token, projectId)).pipe(
              Effect.map(entryOf),
              Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
            ),
            readActive,
          ],
          { concurrency: 2 },
        );
        const facts = people ?? active;
        const sessionIds = entry === null ? [] : projectableSessionIds(entry, launched);
        const fresh = sessionIds.filter((sessionId) => !conversations.has(sessionId));
        // A thread already read whose owner just shared control with someone live: its waiting
        // line, now worth reading (later ones come with its conversation's pointers).
        const waitStarts = sessionIds.filter(
          (sessionId) =>
            conversations.has(sessionId) &&
            readsWaiting(facts.get(sessionId)) &&
            !readsWaiting(active.get(sessionId)),
        );
        const [read, retired, waits] = yield* Effect.all(
          [
            readConversations(fresh, facts),
            readRetirements(sessionIds, facts),
            Effect.forEach(
              waitStarts,
              (sessionId) =>
                readWait(sessionId, facts).pipe(Effect.map((wait) => [sessionId, wait] as const)),
              { concurrency: 4 },
            ),
          ],
          { concurrency: 3 },
        );
        yield* locked(
          Effect.gen(function* () {
            const previous = projects.get(projectId);
            if (entry === null) {
              projects.delete(projectId);
            } else {
              projects.set(projectId, entry);
              seen(entry.sessions.map((session) => session.id));
            }
            const kept = new Set(entry?.sessions.map((session) => session.id) ?? []);
            const finished: Array<string> = [];
            for (const session of previous?.sessions ?? []) {
              if (kept.has(session.id)) continue;
              conversations.delete(session.id);
              adoptedTurns.delete(session.id);
              if (removing.delete(session.id)) finished.push(session.id);
            }
            yield* removed(finished);
            for (const [sessionId, conversation] of read) {
              if (conversation !== null) {
                conversations.set(sessionId, withAdopted(sessionId, conversation));
              }
            }
            for (const [sessionId, wait] of waits) {
              const conversation = conversations.get(sessionId);
              if (conversation !== undefined)
                conversations.set(sessionId, { ...conversation, wait });
            }
            // Control no longer shared, or nobody live: no turn waits, and the line goes.
            for (const sessionId of sessionIds) {
              const conversation = conversations.get(sessionId);
              if (
                conversation !== undefined &&
                conversation.wait !== null &&
                !readsWaiting(facts.get(sessionId))
              ) {
                conversations.set(sessionId, { ...conversation, wait: null });
              }
            }
            active = facts;
            applyRetirements(retired);
            for (const session of entry?.sessions ?? []) sawSession(session.id);
            applied();
            yield* publishAll;
          }),
        );
      });

    const isKnownThread = (sessionId: string): boolean => {
      for (const entry of projects.values()) {
        if (projectableSessionIds(entry, launched).includes(sessionId)) return true;
      }
      return false;
    };

    /** One thread's turns and requests again, and its new items while someone watches it. */
    const refreshConversation = (sessionId: string): Effect.Effect<void, HubReadError> =>
      Effect.gen(function* () {
        // A session that is not a thread yet becomes one through its project's read.
        if (!isKnownThread(sessionId)) return;
        const watch = watches.get(sessionId);
        const [conversation, items] = yield* Effect.all(
          [
            readConversation(sessionId, active),
            watch === undefined ? Effect.succeed([]) : readItemsAfter(sessionId, watch.cursor),
          ],
          { concurrency: 2 },
        );
        yield* locked(
          Effect.gen(function* () {
            if (conversation === null) {
              conversations.delete(sessionId);
              adoptedTurns.delete(sessionId);
            } else if (isKnownThread(sessionId)) {
              conversations.set(sessionId, withAdopted(sessionId, conversation));
            }
            const current = watches.get(sessionId);
            if (current !== undefined) mergeItems(current, items);
            sawSession(sessionId);
            yield* publishAll;
          }),
        );
      });

    let loaded = false;
    /** Refreshes asked for before the first full read finished: run once it has. */
    const deferredKeys = new Set<string>();
    /** The first full read is done: what arrived during it is read again. */
    const markLoaded = Effect.suspend(() => {
      const first = !loaded;
      loaded = true;
      const keys = Array.from(deferredKeys);
      deferredKeys.clear();
      return Effect.forEach(keys, (key) => requestRefresh(key), { discard: true }).pipe(
        // A queue kept across a restart waited for this read: it moves now.
        Effect.andThen(first && queues.size > 0 ? locked(publishAll) : Effect.void),
      );
    });
    const loadLock = Semaphore.makeUnsafe(1);
    /** The first full read, made once by whoever needs it first; a failure is theirs to see. */
    const ensureLoaded = loadLock.withPermits(1)(
      Effect.suspend(() =>
        dead
          ? Effect.fail(new MendDeviceRefused({ operation: "every paired device" }))
          : loaded
            ? Effect.void
            : refreshAll.pipe(Effect.tap(() => markLoaded)),
      ),
    );

    // ─── Refreshing ────────────────────────────────────────────────────────

    /**
     * Every device token of the person, checked against Mend: one it refuses (revoked) ends its
     * sockets, even while the hub reads with another device's token.
     */
    const checkDevices = Effect.suspend(() =>
      Effect.forEach(
        tokens.live(),
        (token) =>
          mend.checkDevice(token).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not check a device with Mend", {
                cause: error.message,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      ),
    );

    /** Pending refreshes, each queued once: a burst of pointers for one key is one read. */
    const pendingKeys = new Set<string>();
    const keys = yield* Queue.unbounded<string>();
    const requestRefresh = (key: string) =>
      Effect.suspend(() => {
        if (pendingKeys.has(key)) return Effect.void;
        pendingKeys.add(key);
        return Queue.offer(keys, key).pipe(Effect.asVoid);
      });

    const refreshOf = (key: string): Effect.Effect<void, HubReadError> => {
      if (key === "all") {
        return loadLock.withPermits(1)(refreshAll.pipe(Effect.tap(() => markLoaded)));
      }
      if (key.startsWith("project:")) return refreshProject(key.slice("project:".length));
      if (key.startsWith("conversation:")) {
        return refreshConversation(key.slice("conversation:".length));
      }
      if (key === "devices") return checkDevices;
      return Effect.void;
    };

    const worker = yield* Effect.forever(
      Queue.take(keys).pipe(
        Effect.flatMap((key) =>
          Effect.suspend(() => {
            pendingKeys.delete(key);
            // Before the first full read ends, a pointer may concern what it already read: keep
            // it for after. Device checks need nothing loaded.
            if (!loaded && key !== "devices") {
              deferredKeys.add(key);
              return Effect.void;
            }
            return refreshOf(key).pipe(
              Effect.catch((error) =>
                Effect.logWarning("t3 gateway could not refresh from Mend", {
                  key,
                  cause: error.message,
                }).pipe(
                  // Mend coming back after a restart answers 502 for a while; the event stream
                  // may reconnect before the full read succeeds, so that read is tried again.
                  Effect.andThen(
                    key === "all"
                      ? Effect.sleep(FULL_READ_RETRY).pipe(
                          Effect.andThen(requestRefresh("all")),
                          Effect.forkScoped,
                          Effect.asVoid,
                        )
                      : Effect.void,
                  ),
                ),
              ),
            );
          }),
        ),
      ),
    ).pipe(Effect.forkScoped);

    // ─── Mend's SSE ────────────────────────────────────────────────────────

    const onPointer = (pointer: MendEventPointer) => {
      const key = refreshKeyOf(pointer);
      return key === null ? Effect.void : requestRefresh(key);
    };

    const sse = yield* Effect.gen(function* () {
      let failures = 0;
      for (let attempt = 0; ; attempt++) {
        // A reconnect may have missed pointers: read everything again.
        if (attempt > 0) yield* requestRefresh("all");
        const startedAt = Date.now();
        const outcome = yield* asPerson((token) =>
          mend.events(token).pipe(Stream.runForEach(onPointer)),
        ).pipe(Effect.result);
        if (outcome._tag === "Failure") {
          yield* Effect.logWarning("t3 gateway lost Mend's event stream", {
            cause: outcome.failure.message,
          });
        }
        failures = Date.now() - startedAt > HEALTHY_STREAM_MS ? 0 : failures + 1;
        yield* Effect.sleep(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** failures));
      }
    }).pipe(Effect.forkScoped);

    const deviceChecks = yield* requestRefresh("devices").pipe(
      Effect.delay(DEVICE_CHECK_INTERVAL),
      Effect.forever,
      Effect.forkScoped,
    );

    // ─── Teardown ──────────────────────────────────────────────────────────

    /** What else must end with the hub (set by later parts: the queue). */
    let onTeardown: Effect.Effect<void> = Effect.void;
    /**
     * Every device of the person was revoked: Mend keeps the event stream open (it closes it only
     * when the account goes), so the hub stops it itself, stops reading, and lets go of itself.
     */
    const teardown = Effect.gen(function* () {
      dead = true;
      yield* Fiber.interruptAll([sse, worker, deviceChecks]);
      yield* Effect.suspend(() => onTeardown);
      yield* input.dispose ?? Effect.void;
    });
    yield* tokens.noneLeft.pipe(Effect.andThen(teardown), Effect.forkScoped);
    // ─── The queue ─────────────────────────────────────────────────────────

    const queueOf = (sessionId: string): Queueing.ThreadQueue => {
      const existing = queues.get(sessionId);
      if (existing !== undefined) return existing;
      const created = Queueing.emptyQueue();
      queues.set(sessionId, created);
      return created;
    };

    /** What Mend says of the session now, for the queue's rules (`queue.ts`). */
    const viewOf = (sessionId: string): Queueing.SessionView => {
      const source = sourceOf(sessionId);
      if (source === null) {
        return {
          known: false,
          agentLive: false,
          turnOpen: false,
          status: null,
          updatedAt: null,
          summary: null,
          evidence: evidence.get(sessionId) ?? 0,
        };
      }
      const turns = conversations.get(sessionId)?.turns ?? [];
      return {
        known: true,
        agentLive: source.agent.exitedAt === null && source.agent.status === "running",
        turnOpen: turns.some((turn) => turn.status === "queued" || turn.status === "running"),
        status: source.session.status,
        updatedAt: source.session.updatedAt,
        summary: source.session.summary ?? null,
        evidence: evidence.get(sessionId) ?? 0,
      };
    };

    /** The message is its Mend turn, by the id `POST /turns` answered; it keeps the client's ids. */
    const adopt = (sessionId: string, entry: Queueing.QueueEntry, turn: MendTurn) =>
      Effect.gen(function* () {
        const ids: TurnIds = {
          sessionId,
          turnId: turn.id,
          runId: entry.runId,
          messageId: entry.messageId,
        };
        rememberIds(ids);
        // The ids first: until they are kept, the message stays kept as being sent (593-R2-2).
        const recorded = yield* state.recordTurnIds(ids, Date.now()).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError("t3 gateway could not record a turn's ids", {
              cause: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!recorded && keeper !== null) {
          const [stored] = Queueing.storedOf({ held: false, entries: [entry] }).entries;
          if (stored !== undefined) {
            const waiting = unrecorded.get(sessionId) ?? [];
            waiting.push({ stored: { ...stored, state: "sending" }, ids });
            unrecorded.set(sessionId, waiting);
          }
        }
        Queueing.adopted(queueOf(sessionId), entry);
        const conversation = conversations.get(sessionId) ?? EMPTY_CONVERSATION;
        if (!conversation.turns.some((known) => known.id === turn.id)) {
          conversations.set(sessionId, { ...conversation, turns: [...conversation.turns, turn] });
          // Kept until a read shows it: a read from before Mend took it may still land.
          const adopted = adoptedTurns.get(sessionId) ?? new Map<string, MendTurn>();
          adopted.set(turn.id, turn);
          adoptedTurns.set(sessionId, adopted);
        }
        // Taken back while it was being sent: its own turn, by id, is interrupted.
        if (entry.takenBack) {
          yield* Effect.forkIn(
            mend.interruptTurn(entry.token, turn.id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("t3 gateway could not interrupt a taken-back turn", {
                  cause: error.message,
                }),
              ),
            ),
            hubScope,
          );
        }
      });

    /** `POST /turns` with the message: Mend answers its turn. */
    const sendTurn = (sessionId: string, entry: Queueing.QueueEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sent = yield* mend.submitTurn(entry.token, sessionId, entry.text).pipe(Effect.result);
        yield* locked(
          Effect.gen(function* () {
            const queue = queueOf(sessionId);
            if (sent._tag === "Success") {
              yield* adopt(sessionId, entry, sent.success);
            } else if (
              sent.failure._tag === "MendCommandRefused" &&
              sent.failure.tag === "ProtocolSessionNotLive"
            ) {
              // Mend says the agent is not live though the row may still read it running: retry
              // only after a backoff and a fresh read, until the send deadline.
              Queueing.notLive(queue, entry, {
                now: performance.now(),
                evidence: evidence.get(sessionId) ?? 0,
                refusal: sent.failure.message,
                timings,
              });
            } else {
              Queueing.fail(queue, entry, reasonOf(sent.failure));
            }
            yield* publishAll;
          }),
        );
        yield* requestRefresh(`conversation:${sessionId}`);
      });

    /**
     * Launches the stopped session again with no prompt: the message goes out by `POST /turns`
     * once Mend reports the agent live. Naming no options, Mend reuses what the session's last
     * protocol agent recorded (mend#493), so an ask session comes back asking. A thread a t3code
     * client launched names what its launch named every time: its first launch may not have
     * brought an agent up, and then Mend has nothing recorded to reuse.
     */
    const launchAgain = (sessionId: string, entry: Queueing.QueueEntry): Effect.Effect<void> =>
      Effect.gen(function* () {
        // A launched thread's options go with its launches only until Mend has recorded a protocol
        // agent for it; from then on Mend reuses what that agent recorded (mend#493), as for every
        // session, so a mode or model changed in Mend is never undone from here.
        const options =
          recordedAgentOf(sessionId) === null ? launched.get(sessionId)?.options : undefined;
        const answer = yield* mend
          .launchProtocol(entry.token, sessionId, "", options)
          .pipe(Effect.result);
        // Mend refuses a launch that races another (`session_starting`) or finds the agent up
        // (`session_active`); its 422 carries only words, so the session itself is read: launching
        // or with a live agent, the launch is under way or done, and the message waits for it.
        const underWay =
          answer._tag === "Failure" &&
          answer.failure._tag === "MendCommandRefused" &&
          answer.failure.status === 422
            ? yield* mend.sessionDetail(entry.token, sessionId).pipe(
                Effect.map((detail) => {
                  const agent = detail.currentAgent;
                  const agentUp =
                    agent !== null &&
                    agent.exitedAt === null &&
                    (agent.status === "running" || agent.status === "starting");
                  return detail.session.status === "starting" || agentUp
                    ? detail.session.updatedAt
                    : null;
                }),
                Effect.orElseSucceed(() => null),
              )
            : null;
        yield* locked(
          Effect.gen(function* () {
            if (answer._tag === "Success") {
              Queueing.launchAnswered(entry, answer.success.updatedAt);
            } else if (underWay !== null) {
              Queueing.launchAnswered(entry, underWay);
            } else {
              Queueing.fail(queueOf(sessionId), entry, reasonOf(answer.failure));
            }
            yield* publishAll;
          }),
        );
        const projectId = sourceOf(sessionId)?.project.id;
        if (projectId !== undefined) yield* requestRefresh(`project:${projectId}`);
      });

    /** The protocol agent Mend has recorded for a session, or null when it has none yet. */
    const recordedAgentOf = (sessionId: string): MendProcess | null => {
      for (const entry of projects.values()) {
        const agent = entry.annotations.get(sessionId)?.currentAgent ?? null;
        if (agent !== null && agent.kind === "agent-protocol") return agent;
      }
      return null;
    };

    /** Session id → when its queue is next looked at without a read (a retry, a deadline). */
    const wakes = new Map<string, number>();
    /**
     * Looks at a thread's queue again when it next needs it: a fresh read of its project, which is
     * the evidence a retry waits for, and moves a launch past its deadline.
     */
    const scheduleWake = (sessionId: string, queue: Queueing.ThreadQueue) =>
      Effect.suspend(() => {
        const at = Queueing.nextWake(queue);
        const scheduled = wakes.get(sessionId);
        if (at === null || (scheduled !== undefined && scheduled <= at)) return Effect.void;
        wakes.set(sessionId, at);
        const projectId = sourceOf(sessionId)?.project.id;
        return Effect.sleep(Math.max(0, at - performance.now())).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (wakes.get(sessionId) === at) wakes.delete(sessionId);
            }),
          ),
          Effect.andThen(
            projectId === undefined ? locked(publishAll) : requestRefresh(`project:${projectId}`),
          ),
          Effect.forkIn(hubScope),
          Effect.asVoid,
        );
      });

    /** Each thread's next step, after any read (`queue.ts` decides; this carries it out). */
    settleQueues = Effect.suspend(() =>
      Effect.forEach(
        Array.from(queues),
        ([sessionId, queue]) => {
          // Before the first full read, nothing is known of any session yet; a launched session no
          // read has shown yet is not gone either.
          if (!loaded || opening.has(sessionId)) return Effect.void;
          const step = Queueing.nextStep(queue, viewOf(sessionId), performance.now(), timings);
          const work =
            step === null
              ? Effect.void
              : Effect.gen(function* () {
                  // The step is kept before it is taken: a message the state file still reads as
                  // queued would be sent again after a restart. A send it cannot keep never goes.
                  const kept = yield* keepQueue(sessionId, queue);
                  if (!kept && step.kind === "send") {
                    Queueing.fail(queue, step.entry, NOT_KEPT);
                    yield* keepQueue(sessionId, queue);
                    return;
                  }
                  yield* Effect.forkIn(
                    step.kind === "send"
                      ? sendTurn(sessionId, step.entry)
                      : launchAgain(sessionId, step.entry),
                    hubScope,
                  );
                });
          return Effect.andThen(work, scheduleWake(sessionId, queue));
        },
        { discard: true },
      ),
    );

    /** Every device of the person was revoked: what was queued for them fails, the lease goes. */
    onTeardown = locked(
      Effect.gen(function* () {
        for (const queue of queues.values()) {
          Queueing.failAll(queue, "Every device of this person was revoked in Mend.");
        }
        yield* keepQueues;
        yield* publishShell;
        yield* publishThreads;
        busy = false;
        yield* retain(false);
      }),
    );

    const refused = (reason: string, authorization = false) =>
      Effect.fail(new ThreadCommandRefused({ reason, authorization }));

    /**
     * Changes a thread's queue and keeps it before anything is acknowledged (review 593-R2-1, the
     * write-first rule): when the state file refuses the change, the queue is put back as it was,
     * and the command fails rather than be acknowledged and lost on a restart. `change` answers
     * false when there was nothing to change; then nothing is written either.
     */
    const changeKept = (sessionId: string, change: (queue: Queueing.ThreadQueue) => boolean) =>
      Effect.gen(function* () {
        const queue = queueOf(sessionId);
        const held = queue.held;
        const entries = [...queue.entries];
        const fields = queue.entries.map((entry) => [entry, { ...entry }] as const);
        if (!change(queue)) return false;
        if (yield* keepQueue(sessionId, queue)) return true;
        queue.held = held;
        queue.entries = entries;
        for (const [entry, before] of fields) Object.assign(entry, before);
        return yield* refused(QUEUE_NOT_KEPT);
      });

    const send: ThreadCommands["send"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        // Reserved before anything is read, so a copy sent concurrently is one message; released
        // again if this one is refused, so a retry is taken.
        if (handledCommands.has(command.commandId)) return sequence;
        handledCommands.add(command.commandId);
        const release = Effect.sync(() => {
          handledCommands.delete(command.commandId);
        });
        return yield* sendReserved(command).pipe(Effect.onError(() => release));
      });

    const sendReserved: ThreadCommands["send"] = (command) =>
      Effect.gen(function* () {
        // Mend's steering rule, read as the sender: only those who may steer queue a message.
        const detail = yield* mend
          .sessionDetail(command.session.deviceToken, command.threadId)
          .pipe(Effect.catchTag("MendNotFound", () => Effect.succeed(null)));
        if (detail === null)
          return yield* refused(`Thread ${command.threadId} is not in this environment.`);
        if (detail.control?.steer === false) {
          return yield* refused(
            "This session is not yours to steer. Its owner can turn on shared control in Mend.",
            true,
          );
        }
        return yield* locked(
          Effect.gen(function* () {
            if (sourceOf(command.threadId) === null) {
              return yield* refused(`Thread ${command.threadId} is not in this environment.`);
            }
            // A client re-sends a command it saw no answer to, a restart of the gateway in between
            // too: a message already kept or sent is the same message.
            if (
              queueOf(command.threadId).entries.some(
                (entry) => entry.messageId === command.messageId,
              ) ||
              Array.from(turnIds.get(command.threadId)?.messageIds.values() ?? []).includes(
                command.messageId,
              )
            ) {
              return sequence;
            }
            yield* changeKept(command.threadId, (queue) => {
              queue.entries.push(
                Queueing.newEntry({
                  runId: `t3-run:${randomUUID()}`,
                  messageId: command.messageId,
                  text: command.text,
                  requestedAt: new Date().toISOString(),
                  token: command.session.deviceToken,
                  sender: command.session.sessionId,
                }),
              );
              return true;
            });
            yield* publishAll;
            return sequence;
          }),
        );
      });

    /** The Mend turn a run is: the turn the gateway sent it as, or the turn of that id. */
    const turnOfRun = (sessionId: string, runId: string): MendTurn | null => {
      const runIds = turnIds.get(sessionId)?.runIds ?? NO_IDS;
      let turnId = runId;
      for (const [candidate, minted] of runIds) {
        if (minted === runId) turnId = candidate;
      }
      return conversations.get(sessionId)?.turns.find((turn) => turn.id === turnId) ?? null;
    };

    /** Takes a message back wherever it is on its way, holding the queue if asked. */
    const takeBack = (threadId: string, runId: string, holdQueue: boolean) =>
      locked(
        Effect.gen(function* () {
          const taken = yield* changeKept(threadId, (queue) =>
            Queueing.takeBack(queue, runId, holdQueue),
          );
          if (!taken) return yield* refused("That message is not queued any more.");
          yield* publishAll;
          return sequence;
        }),
      );

    const cancelQueued: ThreadCommands["cancelQueued"] = (threadId, runId) =>
      takeBack(threadId, runId, false);

    const interrupt: ThreadCommands["interrupt"] = (command) =>
      Effect.gen(function* () {
        const target = yield* locked(
          Effect.gen(function* () {
            const queue = queueOf(command.threadId);
            if (queue.entries.some((entry) => entry.runId === command.runId)) {
              return { kind: "queued" as const };
            }
            const turn = turnOfRun(command.threadId, command.runId);
            if (turn === null) return yield* refused(`Run ${command.runId} is not in this thread.`);
            const wasHeld = queue.held;
            // Held before the turn ends, so the next message does not go out behind it.
            yield* changeKept(command.threadId, (held) => {
              Queueing.holdIfQueued(held, command.holdQueue);
              return true;
            });
            yield* publishAll;
            return { kind: "turn" as const, turn, wasHeld };
          }),
        );
        // A message still in the queue or on its way: taken back, honouring holdQueue too.
        if (target.kind === "queued") {
          return yield* takeBack(command.threadId, command.runId, command.holdQueue);
        }
        yield* mend.interruptTurn(command.session.deviceToken, target.turn.id).pipe(
          Effect.catchTags({
            MendCommandRefused: (e) => Effect.fail(commandRefusalOf(e)),
            MendNotFound: (e) => Effect.fail(commandRefusalOf(e)),
          }),
          Effect.tapError(() =>
            locked(
              Effect.gen(function* () {
                queueOf(command.threadId).held = target.wasHeld;
                yield* publishAll;
              }),
            ),
          ),
        );
        yield* requestRefresh(`conversation:${command.threadId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    const resumeQueue: ThreadCommands["resumeQueue"] = (threadId) =>
      locked(
        Effect.gen(function* () {
          yield* changeKept(threadId, (queue) => {
            Queueing.resume(queue);
            return true;
          });
          yield* publishAll;
          return sequence;
        }),
      );

    /** A change to what is still waiting in a thread's queue, published at once. */
    /** An edit or a reorder, kept before it is acknowledged (594-R2-1): refused, nothing changed. */
    const changeQueue = (sessionId: string, change: (queue: Queueing.ThreadQueue) => boolean) =>
      locked(
        Effect.gen(function* () {
          if (!(yield* changeKept(sessionId, change))) {
            return yield* refused("That message is not waiting in the queue any more.");
          }
          yield* publishAll;
          return sequence;
        }),
      );

    const respond: ThreadCommands["respond"] = (command) =>
      Effect.gen(function* () {
        const known = yield* locked(
          Effect.sync(
            () =>
              conversations
                .get(command.threadId)
                ?.requests.some((request) => request.id === command.requestId) ?? false,
          ),
        );
        if (!known) return yield* refused(`Request ${command.requestId} is not in this thread.`);
        yield* mend
          .respondRequest(command.session.deviceToken, command.requestId, command.response)
          .pipe(
            Effect.catchTags({
              MendCommandRefused: (e) => Effect.fail(commandRefusalOf(e)),
              MendNotFound: (e) => Effect.fail(commandRefusalOf(e)),
            }),
          );
        yield* requestRefresh(`conversation:${command.threadId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    /** Mend's refusal of a command as the thread command's. */
    const asCommandRefusal = <A>(
      effect: MendCommand<A>,
    ): Effect.Effect<A, ThreadCommandRefused | MendDeviceRefused | MendUnavailable> =>
      effect.pipe(
        Effect.catchTags({
          MendCommandRefused: (error) => Effect.fail(commandRefusalOf(error)),
          MendNotFound: (error) => Effect.fail(commandRefusalOf(error)),
        }),
      );

    /**
     * `wanted` with a random suffix (`health-check-k3x9qa`) no worktree of the project has; null
     * when unsure, and Mend names it. Mend joins an existing worktree of the same name, and a
     * lookup alone reserves nothing: two launches, or another Mend client, could take a name both
     * saw free (review 590-R2-1). The suffix makes the name its own whoever creates at once.
     */
    const freeWorktreeName = (token: string, projectId: string, wanted: string) =>
      mend.worktreeNames(token, projectId).pipe(
        Effect.map((names) => {
          const taken = new Set(names);
          for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = `${wanted.slice(0, WORKTREE_NAME_STEM)}-${worktreeSuffix()}`;
            if (!taken.has(candidate)) return candidate;
          }
          return null;
        }),
        Effect.orElseSucceed(() => null),
      );

    /**
     * Launch commands and client thread ids under way, so a retry sent while the first runs is not
     * a second thread, and two launches never take one thread id.
     */
    const launching = new Set<string>();

    const launchReserved = (request: ThreadLaunch) =>
      Effect.gen(function* () {
        const token = request.session.deviceToken;
        const target = yield* locked(
          Effect.sync(() => {
            if (
              request.threadId !== null &&
              (sessionOfThread.has(request.threadId) || isKnownThread(request.threadId))
            ) {
              return { kind: "taken" as const };
            }
            const entry = projects.get(request.projectId);
            if (entry === undefined) return { kind: "no-project" as const };
            const { workspace } = request;
            if (workspace.kind === "new") {
              return { kind: "new" as const, name: workspace.name, base: workspace.base };
            }
            // A worktree is known by the path of a session in it: the same directory.
            const joined = entry.sessions.find(
              (session) => worktreePathOf(entry.project, session) === workspace.worktreePath,
            );
            return joined === undefined
              ? { kind: "no-worktree" as const }
              : { kind: "join" as const, worktreeId: joined.worktreeId };
          }),
        );
        if (target.kind === "taken") {
          return yield* refused(`Thread ${request.threadId ?? ""} is already in this environment.`);
        }
        if (target.kind === "no-project") {
          return yield* refused(`Project ${request.projectId} is not in this environment.`);
        }
        if (target.kind === "no-worktree") {
          return yield* refused(
            request.workspace.kind === "join"
              ? `No session of this project works in ${request.workspace.worktreePath}.`
              : "No such worktree.",
          );
        }
        // Mend joins an existing worktree of the same name: a new worktree takes a name no
        // worktree of the project has, or none, and Mend names it.
        const name =
          target.kind === "new" && target.name !== null
            ? yield* freeWorktreeName(token, request.projectId, target.name)
            : null;
        const created = yield* asCommandRefusal(
          target.kind === "new"
            ? mend.createSession(token, request.projectId, {
                harness: request.harness,
                label: request.label,
                name,
                base: target.base,
              })
            : mend.joinWorktree(token, target.worktreeId, {
                harness: request.harness,
                label: request.label,
              }),
        );
        const thread: LaunchedThread = {
          threadId: request.threadId ?? created.id,
          sessionId: created.id,
          commandId: request.commandId,
          options: request.options,
        };
        yield* state.recordThread(request.session.mendUser.id, thread, Date.now()).pipe(
          Effect.catch((error) =>
            Effect.logError("t3 gateway could not record a launched thread", {
              cause: error.message,
            }),
          ),
        );
        yield* locked(
          Effect.sync(() => {
            rememberThread(thread);
            opening.add(created.id);
          }),
        );
        const { message } = request;
        // The opening message is queued like any other: the queue launches the session on what
        // the launch named and sends the message as an exact turn once the agent runs.
        const queueOpening = () => {
          if (message === null) return;
          const queue = queueOf(created.id);
          if (queue.entries.some((entry) => entry.messageId === message.messageId)) return;
          queue.entries.push(
            Queueing.newEntry({
              runId: `t3-run:${randomUUID()}`,
              messageId: message.messageId,
              text: message.text,
              requestedAt: new Date().toISOString(),
              token,
              sender: request.session.sessionId,
            }),
          );
        };
        // The message is queued at once, whatever the reads below find: it is never dropped.
        // Until a project read shows the session, it stays hidden and its queue waits.
        yield* locked(Effect.sync(queueOpening));
        // The session as Mend has it now, so the thread is in the shell, with its message, before
        // the launch answers: t3code's client opens a launched thread only once its shell shows it.
        const read = (attempts: number) =>
          refreshProject(request.projectId).pipe(
            Effect.retry({ times: attempts, schedule: Schedule.spaced(OPENING_READ_RETRY) }),
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not read a launched thread's project", {
                cause: error.message,
              }),
            ),
          );
        yield* read(OPENING_READ_ATTEMPTS);
        if (yield* locked(Effect.sync(() => opening.has(created.id)))) {
          // Mend not answering yet: keep reading in the background; the message waits for it.
          yield* Effect.forkIn(
            read(OPENING_READ_BACKGROUND_ATTEMPTS).pipe(
              Effect.andThen(
                locked(
                  Effect.gen(function* () {
                    if (!opening.has(created.id)) return;
                    opening.delete(created.id);
                    Queueing.failAll(
                      queueOf(created.id),
                      "Mend created the session, but the gateway could not read it to send this message.",
                    );
                    yield* publishAll;
                  }),
                ),
              ),
            ),
            hubScope,
          );
        }
        if (message === null) {
          // Nothing to send: the agent comes up now, and a refusal is the launch's.
          yield* asCommandRefusal(mend.launchProtocol(token, created.id, "", request.options)).pipe(
            Effect.tap(() => requestRefresh(`project:${request.projectId}`)),
          );
        }
        const launchedId: LaunchedThreadId = { threadId: thread.threadId, resumed: false };
        return launchedId;
      });

    const launch: ThreadCommands["launch"] = (request) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const known = Array.from(launched.values()).find(
          (thread) => thread.commandId === request.commandId,
        );
        if (known !== undefined) {
          const resumed: LaunchedThreadId = { threadId: known.threadId, resumed: true };
          return resumed;
        }
        if (request.session.mendUser.id !== launcher) {
          return yield* refused("A launch is the paired person's own.", true);
        }
        const reserved = [
          `command:${request.commandId}`,
          ...(request.threadId === null ? [] : [`thread:${request.threadId}`]),
        ];
        if (reserved.some((key) => launching.has(key))) {
          return yield* refused("This launch is already under way.");
        }
        for (const key of reserved) launching.add(key);
        return yield* launchReserved(request).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const key of reserved) launching.delete(key);
            }),
          ),
        );
      });

    /** The project of a thread the person has, or a refusal naming the thread. */
    const projectOfThread = (threadId: string, sessionId: string) =>
      locked(Effect.sync(() => sourceOf(sessionId)?.project.id ?? null)).pipe(
        Effect.flatMap((projectId) =>
          projectId === null
            ? refused(`Thread ${threadId} is not in this environment.`)
            : Effect.succeed(projectId),
        ),
      );

    const rename: ThreadCommands["rename"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        yield* asCommandRefusal(
          mend.labelSession(command.session.deviceToken, sessionId, command.title),
        );
        yield* refreshProject(projectId).pipe(Effect.catch(() => requestRefresh("all")));
        return yield* locked(Effect.sync(() => sequence));
      });

    const stop: ThreadCommands["stop"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        yield* asCommandRefusal(mend.stopSession(command.session.deviceToken, sessionId));
        // A stopped session is not launched again for what was already queued; resuming is.
        yield* locked(
          Effect.gen(function* () {
            Queueing.holdIfQueued(queueOf(sessionId), true);
            yield* publishAll;
          }),
        );
        yield* requestRefresh(`project:${projectId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    const remove: ThreadCommands["remove"] = (command) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const token = command.session.deviceToken;
        const sessionId = sessionIdOf(command.threadId);
        const projectId = yield* projectOfThread(command.threadId, sessionId);
        // Mend removes only a settled session; a live one is stopped first, once.
        const report = yield* asCommandRefusal(
          mend
            .removeSession(token, sessionId)
            .pipe(
              Effect.catch((error) =>
                error._tag === "MendCommandRefused" && error.tag === "SessionActive"
                  ? mend
                      .stopSession(token, sessionId)
                      .pipe(Effect.andThen(mend.removeSession(token, sessionId)))
                  : Effect.fail(error),
              ),
            ),
        );
        if (!report.removed && launcher !== null) {
          // Kept before the thread goes, so a restart never brings it back.
          yield* state.keepRemoval(launcher, sessionId, Date.now()).pipe(
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not keep a pending removal", {
                cause: error.message,
              }),
            ),
          );
        }
        yield* locked(
          Effect.gen(function* () {
            // Mend keeps the row until its workspace has stopped; t3code's client has let it go.
            if (!report.removed) removing.add(sessionId);
            Queueing.failAll(queueOf(sessionId), "The thread was deleted.");
            yield* publishAll;
          }),
        );
        // The client's id for the thread goes with it, removed now or once its workspace stops.
        if (launcher !== null) {
          yield* state.forgetThread(launcher, sessionId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not forget a deleted thread", {
                cause: error.message,
              }),
            ),
          );
        }
        yield* requestRefresh(`project:${projectId}`);
        return yield* locked(Effect.sync(() => sequence));
      });

    // A thread a t3code client launched is addressed by the client's id; everything inside the
    // hub is keyed by the Mend session.
    const commands: ThreadCommands = {
      send: (command) => send({ ...command, threadId: sessionIdOf(command.threadId) }),
      interrupt: (command) => interrupt({ ...command, threadId: sessionIdOf(command.threadId) }),
      cancelQueued: (threadId, runId) => cancelQueued(sessionIdOf(threadId), runId),
      resumeQueue: (threadId) => resumeQueue(sessionIdOf(threadId)),
      editQueued: (threadId, runId, text) =>
        changeQueue(sessionIdOf(threadId), (queue) => Queueing.edit(queue, runId, text)),
      reorderQueued: (threadId, runId, beforeRunId) =>
        changeQueue(sessionIdOf(threadId), (queue) => Queueing.reorder(queue, runId, beforeRunId)),
      respond: (command) => respond({ ...command, threadId: sessionIdOf(command.threadId) }),
      launch,
      rename,
      stop,
      remove,
    };

    // ─── The hub ───────────────────────────────────────────────────────────

    const shellSnapshot = ensureLoaded.pipe(Effect.andThen(locked(Effect.sync(currentShell))));

    const subscribeShell = (afterSequence: number | undefined) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        // Subscribed before the snapshot or the replay is taken: nothing published after it is
        // missed, and what both carry has a sequence the client already holds, which it drops.
        const changes = yield* shellChanges.subscribe(() => true);
        const start = yield* locked(
          Effect.sync((): ShellSubscription["start"] => {
            const deltas =
              afterSequence === undefined || !sequencer.owns(afterSequence)
                ? null
                : shellLog.since(afterSequence, sequence);
            return deltas === null
              ? { kind: "snapshot", snapshot: currentShell() }
              : { kind: "replay", deltas };
          }),
        );
        const subscribed: ShellSubscription = { start, changes };
        return subscribed;
      });

    const threadSnapshot = (threadId: string) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        const watched = watches.has(threadId);
        if (!watched && !(yield* locked(Effect.sync(() => isKnownThread(threadId))))) return null;
        // An unwatched thread's items are read for this snapshot alone.
        const items = watched ? null : yield* readItemsAfter(threadId, 0);
        return yield* locked(
          Effect.gen(function* () {
            const source = sourceOf(threadId);
            if (source === null) return null;
            const built =
              items === null
                ? yield* publishThread(threadId)
                : (yield* printProjection(threadProjectionOf(source, items))).projection;
            if (built === null) return null;
            const snapshot: ThreadSnapshot = { snapshotSequence: sequence, projection: built };
            return snapshot;
          }),
        );
      });

    const subscribeThread = (threadId: string, afterSequence?: number) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        if (!(yield* locked(Effect.sync(() => isKnownThread(threadId))))) return null;
        const watch = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const existing = watches.get(threadId);
            if (existing !== undefined) {
              existing.count += 1;
              return existing;
            }
            const fresh: Watch = {
              count: 1,
              idle: 0,
              items: new Map(),
              cursor: 0,
              prints: null,
              thread: null,
              log: null,
            };
            watches.set(threadId, fresh);
            return fresh;
          }),
          // Kept a while after its last subscriber, so a client that reconnects resumes it.
          (held) =>
            Effect.suspend(() => {
              held.count -= 1;
              if (held.count > 0) return Effect.void;
              // A subscriber that came and went since leaves its own full grace.
              const idle = ++held.idle;
              return Effect.sleep(WATCH_GRACE).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (held.count === 0 && held.idle === idle && watches.get(threadId) === held)
                      watches.delete(threadId);
                  }),
                ),
                Effect.forkIn(hubScope),
                Effect.asVoid,
              );
            }),
        );
        const [read, retired] = yield* Effect.all(
          [readItemsAfter(threadId, watch.cursor), readRetirements([threadId], active)],
          { concurrency: 2 },
        );
        // Subscribed before the snapshot is taken: nothing published after it is missed.
        // Only this thread's changes are buffered for it.
        const published = yield* threadChanges.subscribe((change) => change.threadId === threadId);
        const opened = yield* locked(
          Effect.gen(function* () {
            // What the client missed is taken before catching up: the catch-up's own changes
            // reach it through `published`.
            const missed =
              afterSequence === undefined || watch.log === null || !sequencer.owns(afterSequence)
                ? null
                : watch.log.since(afterSequence, sequence);
            mergeItems(watch, read);
            applyRetirements(retired);
            const projection = yield* publishThread(threadId);
            return { missed, projection, at: sequence };
          }),
        );
        if (opened.projection === null) return null;
        const changes = published.pipe(Stream.map((change) => change.change));
        const subscribed: ThreadSubscription = {
          start:
            opened.missed === null
              ? {
                  kind: "snapshot",
                  snapshot: { snapshotSequence: opened.at, projection: opened.projection },
                }
              : { kind: "replay", changes: opened.missed },
          changes,
        };
        return subscribed;
      });

    const changeOfWorktree = (worktreePath: string) =>
      Effect.gen(function* () {
        yield* ensureLoaded;
        return yield* locked(
          Effect.sync((): WorktreeChange | null => {
            const source = threadSources().find(
              (candidate) => worktreePathOf(candidate.project, candidate.session) === worktreePath,
            );
            if (source === undefined || source.changeId === null) return null;
            return { changeId: source.changeId, baseRef: source.session.baseRef };
          }),
        );
      });

    return {
      shellSnapshot,
      subscribeShell,
      threadSnapshot: (threadId: string) => threadSnapshot(sessionIdOf(threadId)),
      subscribeThread: (threadId: string, afterSequence?: number) =>
        subscribeThread(sessionIdOf(threadId), afterSequence),
      isRefused: tokens.isRefused,
      refusal: tokens.refusal,
      mend,
      commands,
      changeOfWorktree,
    };
  });

// ─── The registry ────────────────────────────────────────────────────────────

/** Every person's hub, one each, kept a while after their last socket closes. */
export class Projections extends Context.Service<
  Projections,
  {
    /** The person's hub, reading with this bearer's device token among theirs. */
    readonly hub: (session: BearerSession) => Effect.Effect<PersonHub, never, Scope.Scope>;
    /**
     * Mend refused a device token outside any hub (the session check): the same refusal the gate
     * makes, closing its sockets and revoking its bearers.
     */
    readonly refuseDevice: (userId: string, deviceToken: string) => Effect.Effect<void>;
  }
>()("@mend/t3-gateway/Projections") {}

/** How a launch reads its new session's project before it answers, and then in the background. */
const OPENING_READ_RETRY = "500 millis";
const OPENING_READ_ATTEMPTS = 3;
const OPENING_READ_BACKGROUND_ATTEMPTS = 60;

/** How long a kept queue waits before its person's hub reads Mend again after a failed read. */
const QUEUE_RESTORE_RETRY = "30 seconds";

/** Why a change to a queue the state file could not keep was refused: nothing changed. */
const QUEUE_NOT_KEPT =
  "The gateway could not write this to its state file, so nothing changed. Try again.";

/** Why a message the state file could not keep was not sent. */
const NOT_KEPT =
  "The gateway could not write this message to its state file, so it did not send it. Send it again.";

/** How many sequences a hub reserves at a time (`reserveSequences`). */
const SEQUENCE_BLOCK = 1_000_000;
/** What a removal costs the replay log: an id and a tag. */
const REMOVAL_BYTES = 128;
/** What a replayed change's envelope (its kind, sequence, ids, event fields) adds, at most. */
const ENVELOPE_BYTES = 512;
/**
 * A replayed change's size as it goes out: its print's UTF-8 bytes and its envelope (review
 * 595-R2-N1), never the print's length in UTF-16 units, which counts a CJK character as one.
 */
const replayBytes = (print: string): number => Buffer.byteLength(print, "utf8") + ENVELOPE_BYTES;
/** How long a thread stays watched after its last subscriber: a reconnect resumes it by replay. */
const WATCH_GRACE = "2 minutes";

/** How long a hub outlives its last user: a client reconnecting finds it warm. */
export const HUB_IDLE_TTL = "2 minutes";

export const ProjectionsLive: Layer.Layer<
  Projections,
  never,
  MendClient | GatewayState | GatewayConfig
> = Layer.effect(
  Projections,
  Effect.gen(function* () {
    const mend = yield* MendClient;
    const state = yield* GatewayState;
    const config = yield* GatewayConfig;
    /** Mend user id → the device tokens of theirs the gateway holds, in pairing order. */
    const known = new Map<string, Set<string>>();
    /** Mend user id → who they are, as their pairing recorded it: whom a hub reads for. */
    const viewers = new Map<string, { readonly id: string; readonly name: string }>();
    /** Device token → completed once Mend refuses it. */
    const refusals = new Map<string, Deferred.Deferred<void>>();
    const refusalOf = (token: string) => {
      const existing = refusals.get(token);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      refusals.set(token, created);
      return created;
    };
    const isRefused = (token: string) => {
      const refusal = refusals.get(token);
      return refusal !== undefined && Deferred.isDoneUnsafe(refusal);
    };
    /** Mend user id → completed once every token of theirs the gateway holds was refused. */
    const exhausted = new Map<string, Deferred.Deferred<void>>();
    const exhaustedOf = (userId: string) => {
      const existing = exhausted.get(userId);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      exhausted.set(userId, created);
      return created;
    };
    const liveOf = (userId: string) =>
      Array.from(known.get(userId) ?? []).filter((token) => !isRefused(token));

    const tokensOf = (userId: string): PersonTokens => ({
      current: () => {
        for (const token of known.get(userId) ?? []) {
          if (!isRefused(token)) return token;
        }
        return null;
      },
      live: () => liveOf(userId),
      refuse: (token) =>
        Effect.suspend(() => {
          if (isRefused(token)) return Effect.void;
          Deferred.doneUnsafe(refusalOf(token), Exit.void);
          // The last device of the person: their hub tears itself down.
          if (liveOf(userId).length === 0) Deferred.doneUnsafe(exhaustedOf(userId), Exit.void);
          // The bearers standing for the device stop authenticating too.
          return state.revokeSessionsForDevice(token, Date.now()).pipe(
            Effect.catch((error) =>
              Effect.logError("t3 gateway could not revoke a refused device's bearers", {
                cause: error.message,
              }),
            ),
          );
        }),
      isRefused,
      refusal: (token) => Deferred.await(refusalOf(token)),
      noneLeft: Deferred.await(exhaustedOf(userId)),
    });

    /** Mend user id → the scope holding their hub while a message is in the gateway's hands. */
    const keepers = new Map<string, Scope.Closeable>();
    const retainFor =
      (userId: string) =>
      (busy: boolean): Effect.Effect<void> =>
        Effect.suspend(() => {
          const held = keepers.get(userId);
          if (busy && held === undefined) {
            const scope = Scope.makeUnsafe();
            keepers.set(userId, scope);
            return RcMap.get(hubs, userId).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.asVoid,
            );
          }
          if (!busy && held !== undefined) {
            keepers.delete(userId);
            return Scope.close(held, Exit.void);
          }
          return Effect.void;
        });

    const hubs: RcMap.RcMap<string, PersonHub> = yield* RcMap.make({
      lookup: (userId: string) => {
        const tokens = tokensOf(userId);
        return makePersonHub({
          // Every call the hub makes with a device token goes through the gate.
          mend: gateDeviceCalls(mend, tokens.refuse),
          viewer: viewers.get(userId) ?? null,
          state,
          tokens,
          retain: retainFor(userId),
          queueTimings: { ...Queueing.DEFAULT_QUEUE_TIMINGS, ...config.queueTimings },
          dispose: RcMap.invalidate(hubs, userId),
        });
      },
      idleTimeToLive: config.hubIdleTimeToLive ?? HUB_IDLE_TTL,
    });

    /** Makes the gateway hold a bearer's device token for its person. */
    const know = (session: BearerSession) => {
      const userId = session.mendUser.id;
      viewers.set(userId, { id: userId, name: session.mendUser.name });
      const tokens = known.get(userId) ?? new Set<string>();
      tokens.add(session.deviceToken);
      known.set(userId, tokens);
      // A person who pairs again after every device was revoked gets a fresh hub.
      const done = exhausted.get(userId);
      if (done !== undefined && Deferred.isDoneUnsafe(done) && liveOf(userId).length > 0) {
        exhausted.delete(userId);
      }
      return userId;
    };

    const hub = (session: BearerSession) => Effect.suspend(() => RcMap.get(hubs, know(session)));

    /**
     * After a restart, every person with a kept message that can still reach Mend gets their hub
     * back without waiting for a client: it reads Mend once, and holds itself while the message is
     * on its way (`retain`). Mend not answering yet is tried again; nothing kept is lost meanwhile.
     */
    const restoreQueues = Effect.gen(function* () {
      const senders = yield* state.peopleWithQueuedMessages();
      const people = new Set(senders.map(know));
      yield* Effect.forEach(
        people,
        (userId) =>
          Effect.scoped(
            RcMap.get(hubs, userId).pipe(Effect.flatMap((held) => held.shellSnapshot)),
          ).pipe(
            // A device Mend refused will not come back; only Mend not answering is waited out.
            Effect.retry({
              schedule: Schedule.spaced(QUEUE_RESTORE_RETRY),
              while: (error) => error._tag === "MendUnavailable",
            }),
            Effect.catch((error) =>
              Effect.logWarning("t3 gateway could not bring a kept queue back", {
                cause: error.message,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("t3 gateway could not read its kept queues", { cause: error.message }),
      ),
    );
    yield* Effect.forkScoped(restoreQueues);

    const refuseDevice = (userId: string, deviceToken: string) =>
      tokensOf(userId).refuse(deviceToken);

    return { hub, refuseDevice };
  }),
);
