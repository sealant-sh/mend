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
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { gateDeviceCalls, type GatedMend } from "./device-gate.ts";
import { makeFanout, type SubscriberFellBehind } from "./fanout.ts";
import {
  MendClient,
  MendDeviceRefused,
  type MendNotFound,
  type MendUnavailable,
} from "./mend-client.ts";
import type {
  MendEventPointer,
  MendItem,
  MendProject,
  MendRequest,
  MendSession,
  MendSessionAnnotation,
  MendTurn,
} from "./mend-workbench.ts";
import {
  isProjectable,
  PROJECTION_SCHEMA_VERSION,
  projectShellOf,
  threadShellOf,
  type ThreadSource,
} from "./shell.ts";
import { GatewayState, type BearerSession } from "./state.ts";
import { threadProjectionOf } from "./thread-projection.ts";

/**
 * The projection hub (ADR 0012, "Projection"): one per paired person, shared by every socket and
 * request of theirs. It holds one Mend SSE stream, re-reads what each pointer names through Mend's
 * API as that person, rebuilds the t3code entities, diffs them against what it last sent, and
 * stamps each change with its own sequence. A fresh snapshot is always a legal reset for a
 * t3code client, so a restarted gateway starts its sequence again without a protocol step.
 */

/** A shell change after the snapshot. */
export type ShellDelta = Exclude<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
>;

/** Mend could not be read as the person: their devices are refused, or Mend did not answer. */
export type HubReadError = MendDeviceRefused | MendUnavailable;

export interface ShellSubscription {
  /** The shell as of subscribing; every later change arrives in `changes`, sequenced after it. */
  readonly snapshot: OrchestrationV2ShellSnapshot;
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
  readonly snapshot: ThreadSnapshot;
  /** Fails with `SubscriberFellBehind` when the subscriber cannot keep up (`fanout.ts`). */
  readonly changes: Stream.Stream<ThreadChange, SubscriberFellBehind>;
}

export interface PersonHub {
  /** The shell now, once the hub has read Mend at least once. */
  readonly shellSnapshot: Effect.Effect<OrchestrationV2ShellSnapshot, HubReadError>;
  /** The shell now and its changes from here, for as long as the scope lasts. */
  readonly subscribeShell: Effect.Effect<ShellSubscription, HubReadError, Scope.Scope>;
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
  ) => Effect.Effect<ThreadSubscription | null, HubReadError, Scope.Scope>;
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
}

interface Printed<A> {
  readonly value: A;
  /** The entity as t3code reads it, encoded: what changed, and proof that it encodes. */
  readonly print: string;
}

/** A thread someone is watching: its items, kept current, and what was last sent of it. */
interface Watch {
  count: number;
  readonly items: Map<string, MendItem>;
  /** The highest item change-feed cursor read so far. */
  cursor: number;
  /** Entity key → its print as last sent; null until the first subscriber's snapshot. */
  prints: Map<string, string> | null;
  /** The thread as last sent, for the `thread.deleted` event if it goes. */
  thread: OrchestrationV2AppThread | null;
}

/** How many items one `GET /api/sessions/:id/items` page asks for. */
const ITEM_PAGE = 500;

const EMPTY_CONVERSATION: Conversation = { turns: [], requests: [] };
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

const projectableSessionIds = (entry: ProjectEntry): ReadonlyArray<string> =>
  entry.sessions
    .filter((session) =>
      isProjectable(session, entry.annotations.get(session.id)?.currentAgent ?? null),
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
  readonly tokens: PersonTokens;
  /** Lets go of the hub in the registry, once it has torn itself down. */
  readonly dispose?: Effect.Effect<void>;
}): Effect.Effect<PersonHub, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { mend, tokens } = input;

    const projects = new Map<string, ProjectEntry>();
    const conversations = new Map<string, Conversation>();
    let sequence = 0;
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

    const threadSources = (): ReadonlyArray<ThreadSource> => {
      const sources: Array<ThreadSource> = [];
      for (const entry of projects.values()) {
        for (const session of entry.sessions) {
          const annotation = entry.annotations.get(session.id);
          const agent = annotation?.currentAgent ?? null;
          if (agent === null || !isProjectable(session, agent)) continue;
          const conversation = conversations.get(session.id) ?? EMPTY_CONVERSATION;
          sources.push({
            project: entry.project,
            session,
            agent,
            changeId: annotation?.changeId ?? null,
            turns: conversation.turns,
            requests: conversation.requests,
            runIds: NO_IDS,
            messageIds: NO_IDS,
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
        deltas.push({ kind: "project.updated", sequence: ++sequence, project: next.value });
      }
      for (const [id, next] of nextThreads) {
        if (shellThreads.get(id)?.print === next.print) continue;
        deltas.push({
          kind: "thread.updated",
          sequence: ++sequence,
          location: "active",
          thread: next.value,
        });
      }
      for (const [id, previous] of shellThreads) {
        if (nextThreads.has(id)) continue;
        deltas.push({
          kind: "thread.removed",
          sequence: ++sequence,
          location: "active",
          threadId: previous.value.id,
        });
      }
      for (const [id, previous] of shellProjects) {
        if (nextProjects.has(id)) continue;
        deltas.push({
          kind: "project.removed",
          sequence: ++sequence,
          projectId: previous.value.id,
        });
      }
      shellProjects = nextProjects;
      shellThreads = nextThreads;
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
      id: EventId.make(`event:${++sequence}`),
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
        const source = sourceOf(sessionId);
        if (source === null) {
          if (watch?.prints !== null && watch?.thread !== null && watch !== undefined) {
            const base = eventBase();
            const thread = watch.thread;
            yield* threadChanges.publish([
              {
                threadId: sessionId,
                change: {
                  kind: "event",
                  sequence,
                  event: {
                    ...base,
                    threadId: thread.id,
                    type: "thread.deleted",
                    payload: { ...thread, deletedAt: base.occurredAt },
                  },
                },
              },
            ]);
            watch.prints = null;
            watch.thread = null;
          }
          return null;
        }
        const built = yield* printProjection(threadProjectionOf(source, itemsOf(sessionId)));
        if (watch === undefined) return built.projection;
        const previous = watch.prints;
        const prints = new Map(built.entities.map((entity) => [entity.key, entity.print]));
        watch.prints = prints;
        watch.thread = built.projection.thread;
        if (previous === null) return built.projection;

        // Something the client holds went away: a fresh snapshot replaces it.
        if (Array.from(previous.keys()).some((key) => !prints.has(key))) {
          yield* threadChanges.publish([
            {
              threadId: sessionId,
              change: {
                kind: "snapshot",
                snapshotSequence: ++sequence,
                projection: built.projection,
              },
            },
          ]);
          return built.projection;
        }
        const changes: Array<{ readonly threadId: string; readonly change: ThreadChange }> = [];
        for (const entity of built.entities) {
          if (previous.get(entity.key) === entity.print) continue;
          const base = eventBase();
          changes.push({
            threadId: sessionId,
            change: {
              kind: "event",
              sequence,
              event: entity.event({ ...base, threadId: built.projection.thread.id }),
            },
          });
        }
        if (changes.length > 0) yield* threadChanges.publish(changes);
        return built.projection;
      });

    /** Every watched thread, after a read that may have moved any of them. */
    const publishThreads = Effect.suspend(() =>
      Effect.forEach(Array.from(watches.keys()), publishThread, { discard: true }),
    );

    const publishAll = Effect.andThen(publishShell, publishThreads);

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

    const readConversation = (sessionId: string) =>
      Effect.all(
        {
          turns: asPerson((token) => mend.listTurns(token, sessionId)),
          requests: asPerson((token) => mend.listRequests(token, sessionId)),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.map((conversation): Conversation | null => conversation),
        // The session went between the list and this read; the next project read drops it.
        Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
      );

    const readConversations = (sessionIds: ReadonlyArray<string>) =>
      Effect.forEach(
        sessionIds,
        (sessionId) =>
          readConversation(sessionId).pipe(
            Effect.map((conversation) => [sessionId, conversation] as const),
          ),
        { concurrency: 4 },
      );

    /** Everything again: every project the person sees, and every thread's turns and requests. */
    const refreshAll: Effect.Effect<void, HubReadError> = Effect.gen(function* () {
      const listed = yield* asPerson((token) => mend.listProjects(token)).pipe(
        Effect.catchTag(
          "MendNotFound",
          (): Effect.Effect<ReadonlyArray<MendProject>> => Effect.succeed([]),
        ),
      );
      const details = yield* Effect.forEach(
        listed,
        (project) =>
          asPerson((token) => mend.projectDetail(token, project.id)).pipe(
            Effect.map(entryOf),
            Effect.catchTag("MendNotFound", (_: MendNotFound) => Effect.succeed(null)),
          ),
        { concurrency: 4 },
      );
      const entries = details.filter((entry): entry is ProjectEntry => entry !== null);
      const read = yield* readConversations(entries.flatMap(projectableSessionIds));
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
          conversations.clear();
          for (const [sessionId, conversation] of read) {
            if (conversation !== null) conversations.set(sessionId, conversation);
          }
          for (const [sessionId, items] of caughtUp) {
            const watch = watches.get(sessionId);
            if (watch !== undefined) mergeItems(watch, items);
          }
          yield* publishAll;
        }),
      );
    });

    /** One project again, and the turns of any thread that is new in it. */
    const refreshProject = (projectId: string): Effect.Effect<void, HubReadError> =>
      Effect.gen(function* () {
        const entry = yield* asPerson((token) => mend.projectDetail(token, projectId)).pipe(
          Effect.map(entryOf),
          Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
        );
        const fresh =
          entry === null
            ? []
            : projectableSessionIds(entry).filter((sessionId) => !conversations.has(sessionId));
        const read = yield* readConversations(fresh);
        yield* locked(
          Effect.gen(function* () {
            const previous = projects.get(projectId);
            if (entry === null) {
              projects.delete(projectId);
            } else {
              projects.set(projectId, entry);
            }
            const kept = new Set(entry?.sessions.map((session) => session.id) ?? []);
            for (const session of previous?.sessions ?? []) {
              if (!kept.has(session.id)) conversations.delete(session.id);
            }
            for (const [sessionId, conversation] of read) {
              if (conversation !== null) conversations.set(sessionId, conversation);
            }
            yield* publishAll;
          }),
        );
      });

    const isKnownThread = (sessionId: string): boolean => {
      for (const entry of projects.values()) {
        if (projectableSessionIds(entry).includes(sessionId)) return true;
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
            readConversation(sessionId),
            watch === undefined ? Effect.succeed([]) : readItemsAfter(sessionId, watch.cursor),
          ],
          { concurrency: 2 },
        );
        yield* locked(
          Effect.gen(function* () {
            if (conversation === null) {
              conversations.delete(sessionId);
            } else if (isKnownThread(sessionId)) {
              conversations.set(sessionId, conversation);
            }
            const current = watches.get(sessionId);
            if (current !== undefined) mergeItems(current, items);
            yield* publishAll;
          }),
        );
      });

    let loaded = false;
    /** Refreshes asked for before the first full read finished: run once it has. */
    const deferredKeys = new Set<string>();
    /** The first full read is done: what arrived during it is read again. */
    const markLoaded = Effect.suspend(() => {
      loaded = true;
      const keys = Array.from(deferredKeys);
      deferredKeys.clear();
      return Effect.forEach(keys, (key) => requestRefresh(key), { discard: true });
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

    // ─── The hub ───────────────────────────────────────────────────────────

    const shellSnapshot = ensureLoaded.pipe(Effect.andThen(locked(Effect.sync(currentShell))));

    const subscribeShell = Effect.gen(function* () {
      yield* ensureLoaded;
      // Subscribed before the snapshot is taken: nothing published after it is missed.
      const changes = yield* shellChanges.subscribe(() => true);
      const snapshot = yield* locked(Effect.sync(currentShell));
      return { snapshot, changes };
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

    const subscribeThread = (threadId: string) =>
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
              items: new Map(),
              cursor: 0,
              prints: null,
              thread: null,
            };
            watches.set(threadId, fresh);
            return fresh;
          }),
          (held) =>
            Effect.sync(() => {
              held.count -= 1;
              if (held.count === 0 && watches.get(threadId) === held) watches.delete(threadId);
            }),
        );
        const read = yield* readItemsAfter(threadId, watch.cursor);
        // Subscribed before the snapshot is taken: nothing published after it is missed.
        // Only this thread's changes are buffered for it.
        const published = yield* threadChanges.subscribe((change) => change.threadId === threadId);
        const projection = yield* locked(
          Effect.gen(function* () {
            mergeItems(watch, read);
            return yield* publishThread(threadId);
          }),
        );
        if (projection === null) return null;
        const snapshot: ThreadSnapshot = { snapshotSequence: sequence, projection };
        const changes = published.pipe(Stream.map((change) => change.change));
        const subscribed: ThreadSubscription = { snapshot, changes };
        return subscribed;
      });

    return {
      shellSnapshot,
      subscribeShell,
      threadSnapshot,
      subscribeThread,
      isRefused: tokens.isRefused,
      refusal: tokens.refusal,
      mend,
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

/** How long a hub outlives its last user: a client reconnecting finds it warm. */
export const HUB_IDLE_TTL = "2 minutes";

export const ProjectionsLive: Layer.Layer<Projections, never, MendClient | GatewayState> =
  Layer.effect(
    Projections,
    Effect.gen(function* () {
      const mend = yield* MendClient;
      const state = yield* GatewayState;
      /** Mend user id → the device tokens of theirs the gateway holds, in pairing order. */
      const known = new Map<string, Set<string>>();
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

      const hubs: RcMap.RcMap<string, PersonHub> = yield* RcMap.make({
        lookup: (userId: string) => {
          const tokens = tokensOf(userId);
          return makePersonHub({
            // Every call the hub makes with a device token goes through the gate.
            mend: gateDeviceCalls(mend, tokens.refuse),
            tokens,
            dispose: RcMap.invalidate(hubs, userId),
          });
        },
        idleTimeToLive: HUB_IDLE_TTL,
      });

      const hub = (session: BearerSession) =>
        Effect.suspend(() => {
          const userId = session.mendUser.id;
          const tokens = known.get(userId) ?? new Set<string>();
          tokens.add(session.deviceToken);
          known.set(userId, tokens);
          // A person who pairs again after every device was revoked gets a fresh hub.
          const done = exhausted.get(userId);
          if (done !== undefined && Deferred.isDoneUnsafe(done) && liveOf(userId).length > 0) {
            exhausted.delete(userId);
          }
          return RcMap.get(hubs, userId);
        });

      const refuseDevice = (userId: string, deviceToken: string) =>
        tokensOf(userId).refuse(deviceToken);

      return { hub, refuseDevice };
    }),
  );
