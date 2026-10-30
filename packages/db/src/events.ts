import type { PgClient } from "@effect/sql-pg";
import { Effect, Schema, Stream } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * One NOTIFY channel carries every domain change; the SSE endpoint and the
 * dispatcher wake on it instead of tight-polling. Payloads are small pointers
 * ("something about this issue/run changed") — clients re-read state through
 * the API, they never trust the payload as data.
 */
export const MEND_EVENTS_CHANNEL = "mend_events";

export const MendEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["issue"]),
    issueId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["run"]),
    runId: Schema.String,
    issueId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["run-progress"]),
    runId: Schema.String,
    issueId: Schema.String,
    sequence: Schema.String,
    line: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["brief"]),
    changeId: Schema.String,
    issueId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["brief-comment"]),
    briefId: Schema.String,
    issueId: Schema.String,
  }),
  // ── Workbench events (plan §9.4) — same pointer discipline as above. ──
  Schema.Struct({
    type: Schema.Literals(["project"]),
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["session"]),
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["session-progress"]),
    sessionId: Schema.String,
    projectId: Schema.String,
    sequence: Schema.String,
    line: Schema.String,
  }),
  Schema.Struct({
    // A workspace process changed: created, status flip, port bound, ended.
    type: Schema.Literals(["session-process"]),
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    // A protocol turn, item, or request changed; clients re-read by cursor.
    type: Schema.Literals(["agent-conversation"]),
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    // The container changed: created, renamed, removed, session membership moved.
    type: Schema.Literals(["worktree"]),
    worktreeId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["session-change"]),
    changeId: Schema.String,
    worktreeId: Schema.String,
    /** The contributing session (the change's mirror); kept while clients migrate. */
    sessionId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["review-comment"]),
    commentId: Schema.String,
    changeId: Schema.String,
    worktreeId: Schema.String,
    projectId: Schema.String,
  }),
  Schema.Struct({
    // One account's own facts changed — connected accounts, paired devices and CLI
    // sign-ins, the git access choice or key. The first-run checklist and Settings
    // re-read the facet; nothing project-scoped moves. `access`: the account was removed
    // from its organization; every process closes its open connections.
    type: Schema.Literals(["user"]),
    userId: Schema.String,
    facet: Schema.Literals(["accounts", "devices", "git-access", "access"]),
  }),
  Schema.Struct({
    // The owner (or an organization owner) turned shared control off: every process closes the
    // terminals and tunnels other accounts hold on this session.
    type: Schema.Literals(["shared-control-off"]),
    sessionId: Schema.String,
    projectId: Schema.String,
    ownerUserId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    // Membership, roles or invitations of one organization changed.
    type: Schema.Literals(["organization"]),
    organizationId: Schema.String,
  }),
]);
export type MendEvent = typeof MendEvent.Type;

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(MendEvent));

/**
 * Inside a transaction the notify rides the transaction's own connection, so PostgreSQL delivers
 * it at COMMIT and drops it on ROLLBACK; outside one it is sent at once. `sql.notify` would check
 * out a second pooled connection and send before the caller commits.
 */
export const notifyEvent = (sql: PgClient.PgClient, event: MendEvent) =>
  Effect.gen(function* () {
    const payload = yield* encodeEvent(event).pipe(Effect.orDie);
    yield* sql`SELECT pg_notify(${MEND_EVENTS_CHANNEL}, ${payload})`.pipe(Effect.orDie);
  });

/** The client's own pool size when none is set. */
const CLIENT_DEFAULT_POOL = 10;

/** LISTEN connections each pool holds now: every one is pinned for as long as its stream runs. */
const pinned = new WeakMap<PgClient.PgClient, number>();

/** The pool's size: a pooled client's config carries it, though `PgClientConfig` does not say so. */
const poolSize = (sql: PgClient.PgClient) => {
  const config = sql.config;
  return "maxConnections" in config && typeof config.maxConnections === "number"
    ? config.maxConnections
    : CLIENT_DEFAULT_POOL;
};

/** How many LISTEN connections a pool may pin: all but one, which is left for queries. */
export const listenBudget = (sql: PgClient.PgClient) => poolSize(sql) - 1;

export const listenRefusal = (sql: PgClient.PgClient, channel: string) =>
  `a LISTEN on ${channel} would pin connection ${(pinned.get(sql) ?? 0) + 1} of a pool of ${poolSize(sql)}, and a pool whose every connection listens answers no query · subscribe to the events bus (apps/api/src/events-bus.ts) instead of calling listenEvents`;

const guarded = new WeakSet<PgClient.PgClient>();

/**
 * Counts every LISTEN the client takes, however its caller reached it (`listenEvents`, a direct
 * `sql.listen`, an alias of the service tag), and refuses, as a defect, the one that would leave
 * its pool no connection for queries. `PgLive` installs it on Mend's pool.
 */
export const guardListens = (sql: PgClient.PgClient): void => {
  if (guarded.has(sql)) return;
  guarded.add(sql);
  const listen = sql.listen;
  const counted: PgClient.PgClient["listen"] = (channel) =>
    Effect.gen(function* () {
      if ((pinned.get(sql) ?? 0) >= listenBudget(sql)) {
        return yield* Effect.die(new Error(listenRefusal(sql, channel)));
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => pinned.set(sql, (pinned.get(sql) ?? 0) + 1)),
        () => Effect.sync(() => pinned.set(sql, (pinned.get(sql) ?? 1) - 1)),
      );
      return yield* listen(channel);
    });
  Reflect.set(sql, "listen", counted);
};

/**
 * The channel's payloads, from the moment PostgreSQL confirms the LISTEN. The stream holds one
 * connection while it runs and fails with the connection's `SqlError` when it drops.
 */
export const listenEvents = (sql: PgClient.PgClient): Stream.Stream<string, SqlError> =>
  Stream.unwrap(
    Effect.map(sql.listen(MEND_EVENTS_CHANNEL), (notifications) =>
      Stream.map(Stream.fromQueue(notifications), (notification) => notification.payload),
    ),
  );
