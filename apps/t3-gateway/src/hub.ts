import {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@mend/t3-contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeFanout, type SubscriberFellBehind } from "./fanout.ts";
import {
  MendClient,
  MendDeviceRefused,
  type MendNotFound,
  type MendUnavailable,
} from "./mend-client.ts";
import type {
  MendEventPointer,
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

export interface PersonHub {
  /** The shell now, once the hub has read Mend at least once. */
  readonly shellSnapshot: Effect.Effect<OrchestrationV2ShellSnapshot, HubReadError>;
  /** The shell now and its changes from here, for as long as the scope lasts. */
  readonly subscribeShell: Effect.Effect<ShellSubscription, HubReadError, Scope.Scope>;
  /** Whether Mend has refused this device token: the device was revoked. */
  readonly isRefused: (token: string) => boolean;
  /** Completes once Mend refuses this device token; a socket holding it closes then. */
  readonly refusal: (token: string) => Effect.Effect<void>;
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

export const makePersonHub = (input: {
  readonly mend: MendClient["Service"];
  readonly tokens: PersonTokens;
}): Effect.Effect<PersonHub, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { mend, tokens } = input;

    const projects = new Map<string, ProjectEntry>();
    const conversations = new Map<string, Conversation>();
    let sequence = 0;
    let shellProjects = new Map<string, Printed<OrchestrationProjectShell>>();
    let shellThreads = new Map<string, Printed<OrchestrationV2ThreadShell>>();
    const shellChanges = makeFanout<ShellDelta>();
    /** Every read of state and every publication happens under it, in order. */
    const lock = Semaphore.makeUnsafe(1);
    const locked = lock.withPermits(1);

    /** Calls Mend with one of the person's tokens, and with another when Mend refuses it. */
    const asPerson = <A, E>(
      call: (token: string) => Effect.Effect<A, E | MendDeviceRefused>,
    ): Effect.Effect<A, E | MendDeviceRefused> =>
      Effect.suspend(() => {
        const token = tokens.current();
        if (token === null) {
          return Effect.fail(new MendDeviceRefused({ operation: "every paired device" }));
        }
        return call(token).pipe(
          Effect.catch((error) => {
            if (!(error instanceof MendDeviceRefused)) return Effect.fail(error);
            return tokens
              .refuse(token)
              .pipe(
                Effect.andThen(tokens.current() === null ? Effect.fail(error) : asPerson(call)),
              );
          }),
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

    // ─── Reading Mend ──────────────────────────────────────────────────────

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
      yield* locked(
        Effect.gen(function* () {
          projects.clear();
          for (const entry of entries) projects.set(entry.project.id, entry);
          conversations.clear();
          for (const [sessionId, conversation] of read) {
            if (conversation !== null) conversations.set(sessionId, conversation);
          }
          yield* publishShell;
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
            yield* publishShell;
          }),
        );
      });

    const isKnownThread = (sessionId: string): boolean => {
      for (const entry of projects.values()) {
        if (projectableSessionIds(entry).includes(sessionId)) return true;
      }
      return false;
    };

    /** One thread's turns and requests again. */
    const refreshConversation = (sessionId: string): Effect.Effect<void, HubReadError> =>
      Effect.gen(function* () {
        // A session that is not a thread yet becomes one through its project's read.
        if (!isKnownThread(sessionId)) return;
        const conversation = yield* readConversation(sessionId);
        yield* locked(
          Effect.gen(function* () {
            if (conversation === null) {
              conversations.delete(sessionId);
            } else if (isKnownThread(sessionId)) {
              conversations.set(sessionId, conversation);
            }
            yield* publishShell;
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
      Effect.suspend(() => (loaded ? Effect.void : refreshAll.pipe(Effect.tap(() => markLoaded)))),
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
            Effect.flatMap((verdict) =>
              verdict === "refused" ? tokens.refuse(token) : Effect.void,
            ),
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

    yield* Effect.forever(
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

    yield* Effect.gen(function* () {
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

    yield* requestRefresh("devices").pipe(
      Effect.delay(DEVICE_CHECK_INTERVAL),
      Effect.forever,
      Effect.forkScoped,
    );

    // ─── The hub ───────────────────────────────────────────────────────────

    const shellSnapshot = ensureLoaded.pipe(Effect.andThen(locked(Effect.sync(currentShell))));

    const subscribeShell = Effect.gen(function* () {
      yield* ensureLoaded;
      // Subscribed before the snapshot is taken: nothing published after it is missed.
      const changes = yield* shellChanges.subscribe(() => true);
      const snapshot = yield* locked(Effect.sync(currentShell));
      return { snapshot, changes };
    });

    return {
      shellSnapshot,
      subscribeShell,
      isRefused: tokens.isRefused,
      refusal: tokens.refusal,
    };
  });

// ─── The registry ────────────────────────────────────────────────────────────

/** Every person's hub, one each, kept a while after their last socket closes. */
export class Projections extends Context.Service<
  Projections,
  {
    /** The person's hub, reading with this bearer's device token among theirs. */
    readonly hub: (session: BearerSession) => Effect.Effect<PersonHub, never, Scope.Scope>;
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

      const tokensOf = (userId: string): PersonTokens => ({
        current: () => {
          for (const token of known.get(userId) ?? []) {
            if (!isRefused(token)) return token;
          }
          return null;
        },
        live: () => Array.from(known.get(userId) ?? []).filter((token) => !isRefused(token)),
        refuse: (token) =>
          Effect.suspend(() => {
            if (isRefused(token)) return Effect.void;
            Deferred.doneUnsafe(refusalOf(token), Exit.void);
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
      });

      const hubs = yield* RcMap.make({
        lookup: (userId: string) => makePersonHub({ mend, tokens: tokensOf(userId) }),
        idleTimeToLive: HUB_IDLE_TTL,
      });

      const hub = (session: BearerSession) =>
        Effect.suspend(() => {
          const tokens = known.get(session.mendUser.id) ?? new Set<string>();
          tokens.add(session.deviceToken);
          known.set(session.mendUser.id, tokens);
          return RcMap.get(hubs, session.mendUser.id);
        });

      return { hub };
    }),
  );
