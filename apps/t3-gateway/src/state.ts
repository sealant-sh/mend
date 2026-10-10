import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  AuthClientMetadataDeviceType,
  AuthEnvironmentScope,
  AuthSessionId,
  EnvironmentId,
} from "@mend/t3-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { GatewayConfig } from "./config.ts";
import type { EntryState, StoredEntry, StoredQueue } from "./queue.ts";

/**
 * The gateway's own state (ADR 0012, "State"): one `node:sqlite` file it owns. Mend's records stay
 * in Mend; losing this file loses only the environment id, paired bearers and t3code-side ids.
 *
 * The file holds every paired person's Mend device token, usable as that person: the gateway calls
 * Mend with it when no client request is in flight (the event stream, device checks, queued sends
 * and relaunches), and after a restart a reconnecting socket carries only a ticket. A hash cannot
 * make those calls, and a key kept beside the file protects nothing the file's mode does not. So
 * only the gateway's own user may read it (`restrictStateFile`).
 */

/** One t3code client's bearer, and the Mend device token it stands for. */
export interface BearerSession {
  readonly sessionId: AuthSessionId;
  /** sha256 of the bearer; the bearer itself is never stored. */
  readonly tokenHash: string;
  /** The device token Mend returned when the pairing code was claimed; every Mend call uses it. */
  readonly deviceToken: string;
  readonly mendUser: { readonly id: string; readonly name: string; readonly email: string };
  readonly mendDeviceId: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly client: {
    readonly label: string | null;
    readonly deviceType: AuthClientMetadataDeviceType;
    readonly os: string | null;
  };
  /** Epoch milliseconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

/**
 * The t3code ids a gateway-sent turn carries (ADR 0012, "State"): the run id the gateway minted
 * when it queued the message, and the message id the t3code client sent it with. A client
 * reconciles its own message by that id, so the map outlives a gateway restart.
 */
export interface TurnIds {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly messageId: string;
}

/**
 * What a launch named for its session's agent (`LaunchRequest` in @mend/api-contracts), kept so
 * every later launch of the thread names the same: a launch that never brought an agent up leaves
 * Mend nothing recorded to reuse.
 */
export const ThreadLaunchOptions = Schema.Struct({
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  permissionMode: Schema.optional(Schema.Literals(["bypass", "ask"])),
  speed: Schema.optional(Schema.Literals(["standard", "fast"])),
});
export type ThreadLaunchOptions = typeof ThreadLaunchOptions.Type;

/**
 * A thread a t3code client launched (`orchestration.launchThread`): the client's own thread id,
 * the Mend session that is it, the launch command (a retry of it is the same thread) and what the
 * launch named.
 */
export interface LaunchedThread {
  readonly threadId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly options: ThreadLaunchOptions;
}

export class GatewayStateError extends Schema.TaggedError<GatewayStateError>()(
  "GatewayStateError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The gateway's state file failed during ${this.operation}.`;
  }
}

export class GatewayState extends Context.Service<
  GatewayState,
  {
    /** Generated once, on the first start, and kept: a client keys its saved environment by it. */
    readonly environmentId: EnvironmentId;
    readonly insertSession: (session: BearerSession) => Effect.Effect<void, GatewayStateError>;
    readonly findSession: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<BearerSession>, GatewayStateError>;
    /** The session a WebSocket ticket was issued for. */
    readonly findSessionById: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<BearerSession>, GatewayStateError>;
    readonly revokeSession: (
      sessionId: AuthSessionId,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Revokes every bearer standing for a Mend device token Mend refused. */
    readonly revokeSessionsForDevice: (
      deviceToken: string,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Records the t3code ids of a turn the gateway sent. */
    readonly recordTurnIds: (ids: TurnIds, at: number) => Effect.Effect<void, GatewayStateError>;
    /** Every turn the gateway sent, with its t3code ids. */
    readonly listTurnIds: () => Effect.Effect<ReadonlyArray<TurnIds>, GatewayStateError>;
    /**
     * Records a thread a person launched from t3code; a second record of its command keeps the
     * first.
     */
    readonly recordThread: (
      mendUserId: string,
      thread: LaunchedThread,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** Every thread a person launched from t3code whose session was not seen removed. */
    readonly listThreads: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyArray<LaunchedThread>, GatewayStateError>;
    /** Forgets a person's launched thread whose session Mend removed. */
    readonly forgetThread: (
      mendUserId: string,
      sessionId: string,
    ) => Effect.Effect<void, GatewayStateError>;
    /**
     * Keeps a session a person deleted that Mend keeps until its workspace has stopped, so it stays
     * hidden from them across a restart.
     */
    readonly keepRemoval: (
      mendUserId: string,
      sessionId: string,
      at: number,
    ) => Effect.Effect<void, GatewayStateError>;
    /** The sessions a person deleted that Mend had not removed when last read. */
    readonly listRemovals: (
      mendUserId: string,
    ) => Effect.Effect<ReadonlyArray<string>, GatewayStateError>;
    /** Forgets a pending removal once Mend no longer lists the session. */
    readonly dropRemoval: (
      mendUserId: string,
      sessionId: string,
    ) => Effect.Effect<void, GatewayStateError>;
    /**
     * Keeps one thread's queue in a person's hub as it stands now; an empty queue that is not held
     * leaves nothing behind.
     */
    readonly saveQueue: (
      mendUserId: string,
      sessionId: string,
      queue: StoredQueue,
    ) => Effect.Effect<void, GatewayStateError>;
    /**
     * Every queue kept for a person, by session, with the device tokens of the senders whose
     * bearer is still live (a sender missing from `senders` is no longer paired).
     */
    readonly loadQueues: (mendUserId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly sessionId: string;
        readonly queue: StoredQueue;
        readonly senders: ReadonlyMap<string, string>;
      }>,
      GatewayStateError
    >;
    /**
     * Reserves `count` sequences at or above `from`, from one high-water mark for the whole
     * gateway, and answers where they start: every sequence a hub stamps comes from a reservation,
     * so none is stamped twice across hubs, people and restarts, and a client resuming after a
     * sequence from another hub is never answered by replay. The mark starts at the clock (in
     * milliseconds), above any sequence a gateway gave before it kept one: those counted from 0.
     */
    readonly reserveSequences: (
      from: number,
      count: number,
    ) => Effect.Effect<number, GatewayStateError>;
    /** The people who have a message kept that can still reach Mend: their hubs start with the gateway. */
    readonly peopleWithQueuedMessages: () => Effect.Effect<
      ReadonlyArray<BearerSession>,
      GatewayStateError
    >;
  }
>()("@mend/t3-gateway/GatewayState") {}

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Migrations by `PRAGMA user_version`. Append only. t3code shows Mend's projects and sessions by
 * their Mend ids, except a thread a t3code client launched, which keeps the client's own id for
 * the person who launched it: `thread_ids` maps it to its session, per person, with the launch's
 * command and options (migration 4). Everyone else sees the session by its Mend id.
 * `project_ids` stays empty. `message_ids` and `run_ids` carry the ids of every turn a t3code
 * client sent, keyed by the Mend turn: a message id comes from the client, so it is never a key
 * across sessions, and a recorded turn is never replaced (migration 3). `pending_removals` keeps
 * each person's deleted sessions that Mend keeps until their workspace has stopped (migration 5).
 * `queued_messages` and `queue_holds` keep each person's queues (migration 6): a message names its
 * sender by bearer session, never by device token.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE bearer_sessions (
    session_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    device_token TEXT NOT NULL,
    mend_user_id TEXT NOT NULL,
    mend_user_name TEXT NOT NULL,
    mend_user_email TEXT NOT NULL,
    mend_device_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    client_label TEXT,
    client_device_type TEXT NOT NULL,
    client_os TEXT,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE project_ids (
    project_id TEXT PRIMARY KEY,
    mend_project_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE thread_ids (
    thread_id TEXT PRIMARY KEY,
    mend_session_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE message_ids (
    message_id TEXT PRIMARY KEY,
    mend_session_id TEXT NOT NULL,
    mend_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (mend_session_id, mend_ref)
  );
  `,
  `
  CREATE TABLE run_ids (
    run_id TEXT PRIMARY KEY,
    mend_session_id TEXT NOT NULL,
    mend_turn_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE message_ids_by_turn (
    mend_session_id TEXT NOT NULL,
    mend_ref TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mend_session_id, mend_ref)
  );
  INSERT OR IGNORE INTO message_ids_by_turn (mend_session_id, mend_ref, message_id, created_at)
    SELECT mend_session_id, mend_ref, message_id, created_at FROM message_ids;
  DROP TABLE message_ids;
  ALTER TABLE message_ids_by_turn RENAME TO message_ids;
  `,
  `
  DROP TABLE thread_ids;
  CREATE TABLE thread_ids (
    mend_user_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    launch_options TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mend_user_id, thread_id),
    UNIQUE (mend_user_id, mend_session_id),
    UNIQUE (mend_user_id, command_id)
  );
  `,
  `
  CREATE TABLE pending_removals (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
  `
  CREATE TABLE queued_messages (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    sender_session_id TEXT NOT NULL,
    state TEXT NOT NULL,
    error TEXT,
    launches INTEGER NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id, position)
  );
  CREATE TABLE queue_holds (
    mend_user_id TEXT NOT NULL,
    mend_session_id TEXT NOT NULL,
    PRIMARY KEY (mend_user_id, mend_session_id)
  );
  `,
];

/** The gateway's sequence high-water mark in `meta` (`reserveSequences`). */
const SEQUENCE_HIGH = "sequence_high";

const UserVersionRow = Schema.Struct({ user_version: Schema.Number });
const MetaRow = Schema.Struct({ value: Schema.String });
const Scopes = Schema.fromJsonString(Schema.Array(AuthEnvironmentScope));
const SessionRow = Schema.Struct({
  session_id: AuthSessionId,
  token_hash: Schema.String,
  device_token: Schema.String,
  mend_user_id: Schema.String,
  mend_user_name: Schema.String,
  mend_user_email: Schema.String,
  mend_device_id: Schema.String,
  scopes: Scopes,
  client_label: Schema.NullOr(Schema.String),
  client_device_type: AuthClientMetadataDeviceType,
  client_os: Schema.NullOr(Schema.String),
  issued_at: Schema.Number,
  expires_at: Schema.Number,
  revoked_at: Schema.NullOr(Schema.Number),
});
const decodeSessionRow = Schema.decodeUnknownEffect(SessionRow);
const TurnIdsRow = Schema.Struct({
  session_id: Schema.String,
  turn_id: Schema.String,
  run_id: Schema.String,
  message_id: Schema.String,
});
const decodeTurnIdsRows = Schema.decodeUnknownEffect(Schema.Array(TurnIdsRow));
const encodeScopes = Schema.encodeSync(Scopes);
const LaunchOptionsJson = Schema.fromJsonString(ThreadLaunchOptions);
const encodeLaunchOptions = Schema.encodeSync(LaunchOptionsJson);
const ThreadRow = Schema.Struct({
  thread_id: Schema.String,
  mend_session_id: Schema.String,
  command_id: Schema.String,
  launch_options: LaunchOptionsJson,
});
const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(ThreadRow));
const RemovalRow = Schema.Struct({ mend_session_id: Schema.String });
const decodeRemovalRows = Schema.decodeUnknownEffect(Schema.Array(RemovalRow));
const QueuedRow = Schema.Struct({
  mend_session_id: Schema.String,
  run_id: Schema.String,
  message_id: Schema.String,
  text: Schema.String,
  requested_at: Schema.String,
  sender_session_id: Schema.String,
  state: Schema.Literals(["queued", "launching", "sending", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
  launches: Schema.Number,
  /** The sender's device token while their bearer is live; null once revoked or gone. */
  device_token: Schema.NullOr(Schema.String),
});
const decodeQueuedRows = Schema.decodeUnknownEffect(Schema.Array(QueuedRow));
const HoldRow = Schema.Struct({ mend_session_id: Schema.String });
const decodeHoldRows = Schema.decodeUnknownEffect(Schema.Array(HoldRow));
const decodeSessionRows = Schema.decodeUnknownEffect(Schema.Array(SessionRow));

const toBearerSession = (decoded: typeof SessionRow.Type): BearerSession => ({
  sessionId: decoded.session_id,
  tokenHash: decoded.token_hash,
  deviceToken: decoded.device_token,
  mendUser: {
    id: decoded.mend_user_id,
    name: decoded.mend_user_name,
    email: decoded.mend_user_email,
  },
  mendDeviceId: decoded.mend_device_id,
  scopes: decoded.scopes,
  client: {
    label: decoded.client_label,
    deviceType: decoded.client_device_type,
    os: decoded.client_os,
  },
  issuedAt: decoded.issued_at,
  expiresAt: decoded.expires_at,
  revokedAt: decoded.revoked_at,
});

const migrate = (database: DatabaseSync): void => {
  const row = Schema.decodeUnknownSync(UserVersionRow)(
    database.prepare("PRAGMA user_version").get(),
  );
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) break;
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};

const ensureEnvironmentId = (database: DatabaseSync): string => {
  database
    .prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('environment_id', ?)")
    .run(randomUUID());
  return Schema.decodeUnknownSync(MetaRow)(
    database.prepare("SELECT value FROM meta WHERE key = 'environment_id'").get(),
  ).value;
};

/**
 * The state file 0600, before SQLite opens it, and a directory the gateway creates 0700. A file an
 * older gateway created with the umask's mode is narrowed on open, and so are SQLite's `-wal` and
 * `-shm` beside it (SQLite creates those with the database file's mode). An existing directory is
 * left as it is: `MEND_T3_GATEWAY_STATE_PATH` may name a directory others use.
 */
const restrictStateFile = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
};

/** Opens (or creates) the state file at `path`, migrated, and closes it with the scope. */
export const openGatewayState = (
  path: string,
): Effect.Effect<GatewayState["Service"], GatewayStateError, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (path !== ":memory:") restrictStateFile(path);
          const opened = new DatabaseSync(path);
          opened.exec("PRAGMA journal_mode = WAL");
          opened.exec("PRAGMA foreign_keys = ON");
          return opened;
        },
        catch: (cause) => new GatewayStateError({ operation: "open", cause }),
      }),
      (opened) => Effect.sync(() => opened.close()),
    );
    const environmentId = yield* Effect.try({
      try: () => {
        migrate(database);
        return EnvironmentId.make(ensureEnvironmentId(database));
      },
      catch: (cause) => new GatewayStateError({ operation: "migrate", cause }),
    });

    const run = <A>(operation: string, f: () => A): Effect.Effect<A, GatewayStateError> =>
      Effect.try({ try: f, catch: (cause) => new GatewayStateError({ operation, cause }) });

    const insertSession = (session: BearerSession) =>
      run("insertSession", () => {
        database
          .prepare(
            `INSERT INTO bearer_sessions (
               session_id, token_hash, device_token, mend_user_id, mend_user_name, mend_user_email,
               mend_device_id, scopes, client_label, client_device_type, client_os, issued_at,
               expires_at, revoked_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.sessionId,
            session.tokenHash,
            session.deviceToken,
            session.mendUser.id,
            session.mendUser.name,
            session.mendUser.email,
            session.mendDeviceId,
            encodeScopes(session.scopes),
            session.client.label,
            session.client.deviceType,
            session.client.os,
            session.issuedAt,
            session.expiresAt,
            session.revokedAt,
          );
      });

    const findOne = (operation: string, query: string, key: string) =>
      run(operation, () => database.prepare(query).get(key)).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.succeed(Option.none<BearerSession>())
            : decodeSessionRow(row).pipe(
                Effect.mapError((cause) => new GatewayStateError({ operation, cause })),
                Effect.map((decoded) => Option.some(toBearerSession(decoded))),
              ),
        ),
      );

    const findSession = (tokenHash: string) =>
      findOne("findSession", "SELECT * FROM bearer_sessions WHERE token_hash = ?", tokenHash);

    const findSessionById = (sessionId: AuthSessionId) =>
      findOne("findSessionById", "SELECT * FROM bearer_sessions WHERE session_id = ?", sessionId);

    const revokeSession = (sessionId: AuthSessionId, at: number) =>
      run("revokeSession", () => {
        database
          .prepare(
            "UPDATE bearer_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
          )
          .run(at, sessionId);
      });

    const revokeSessionsForDevice = (deviceToken: string, at: number) =>
      run("revokeSessionsForDevice", () => {
        database
          .prepare(
            "UPDATE bearer_sessions SET revoked_at = ? WHERE device_token = ? AND revoked_at IS NULL",
          )
          .run(at, deviceToken);
      });
    const recordTurnIds = (ids: TurnIds, at: number) =>
      run("recordTurnIds", () => {
        database.exec("BEGIN");
        try {
          database
            .prepare(
              `INSERT OR IGNORE INTO run_ids (run_id, mend_session_id, mend_turn_id, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(ids.runId, ids.sessionId, ids.turnId, at);
          database
            .prepare(
              `INSERT OR IGNORE INTO message_ids (message_id, mend_session_id, mend_ref, created_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(ids.messageId, ids.sessionId, ids.turnId, at);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });

    const listTurnIds = () =>
      run("listTurnIds", () =>
        database
          .prepare(
            `SELECT r.mend_session_id AS session_id, r.mend_turn_id AS turn_id, r.run_id AS run_id,
                    m.message_id AS message_id
               FROM run_ids r
               JOIN message_ids m ON m.mend_session_id = r.mend_session_id AND m.mend_ref = r.mend_turn_id`,
          )
          .all(),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeTurnIdsRows(rows).pipe(
            Effect.mapError((cause) => new GatewayStateError({ operation: "listTurnIds", cause })),
          ),
        ),
        Effect.map((rows) =>
          rows.map(
            (row): TurnIds => ({
              sessionId: row.session_id,
              turnId: row.turn_id,
              runId: row.run_id,
              messageId: row.message_id,
            }),
          ),
        ),
      );

    const recordThread = (mendUserId: string, thread: LaunchedThread, at: number) =>
      run("recordThread", () => {
        database
          .prepare(
            `INSERT OR IGNORE INTO thread_ids
               (mend_user_id, thread_id, mend_session_id, command_id, launch_options, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mendUserId,
            thread.threadId,
            thread.sessionId,
            thread.commandId,
            encodeLaunchOptions(thread.options),
            at,
          );
      });

    const listThreads = (mendUserId: string) =>
      run("listThreads", () =>
        database
          .prepare(
            `SELECT thread_id, mend_session_id, command_id, launch_options FROM thread_ids
              WHERE mend_user_id = ? ORDER BY created_at`,
          )
          .all(mendUserId),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeThreadRows(rows).pipe(
            Effect.mapError((cause) => new GatewayStateError({ operation: "listThreads", cause })),
          ),
        ),
        Effect.map((rows) =>
          rows.map(
            (row): LaunchedThread => ({
              threadId: row.thread_id,
              sessionId: row.mend_session_id,
              commandId: row.command_id,
              options: row.launch_options,
            }),
          ),
        ),
      );

    const forgetThread = (mendUserId: string, sessionId: string) =>
      run("forgetThread", () => {
        database
          .prepare("DELETE FROM thread_ids WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
      });

    const keepRemoval = (mendUserId: string, sessionId: string, at: number) =>
      run("keepRemoval", () => {
        database
          .prepare(
            `INSERT OR IGNORE INTO pending_removals (mend_user_id, mend_session_id, deleted_at)
             VALUES (?, ?, ?)`,
          )
          .run(mendUserId, sessionId, at);
      });

    const listRemovals = (mendUserId: string) =>
      run("listRemovals", () =>
        database
          .prepare("SELECT mend_session_id FROM pending_removals WHERE mend_user_id = ?")
          .all(mendUserId),
      ).pipe(
        Effect.flatMap((rows) =>
          decodeRemovalRows(rows).pipe(
            Effect.mapError((cause) => new GatewayStateError({ operation: "listRemovals", cause })),
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.mend_session_id)),
      );

    const dropRemoval = (mendUserId: string, sessionId: string) =>
      run("dropRemoval", () => {
        database
          .prepare("DELETE FROM pending_removals WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
      });

    const transaction = (operation: string, f: () => void) =>
      run(operation, () => {
        database.exec("BEGIN");
        try {
          f();
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });

    const saveQueue = (mendUserId: string, sessionId: string, queue: StoredQueue) =>
      transaction("saveQueue", () => {
        database
          .prepare("DELETE FROM queued_messages WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
        database
          .prepare("DELETE FROM queue_holds WHERE mend_user_id = ? AND mend_session_id = ?")
          .run(mendUserId, sessionId);
        const insert = database.prepare(
          `INSERT INTO queued_messages (
             mend_user_id, mend_session_id, position, run_id, message_id, text, requested_at,
             sender_session_id, state, error, launches
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        queue.entries.forEach((entry, position) => {
          insert.run(
            mendUserId,
            sessionId,
            position,
            entry.runId,
            entry.messageId,
            entry.text,
            entry.requestedAt,
            entry.sender,
            entry.state,
            entry.error,
            entry.launches,
          );
        });
        if (queue.held) {
          database
            .prepare("INSERT INTO queue_holds (mend_user_id, mend_session_id) VALUES (?, ?)")
            .run(mendUserId, sessionId);
        }
      });

    const decoded =
      <A>(operation: string, decode: (rows: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
      (rows: unknown) =>
        decode(rows).pipe(Effect.mapError((cause) => new GatewayStateError({ operation, cause })));

    const loadQueues = (mendUserId: string) =>
      Effect.gen(function* () {
        const rows = yield* run("loadQueues", () =>
          database
            .prepare(
              `SELECT q.mend_session_id, q.run_id, q.message_id, q.text, q.requested_at,
                      q.sender_session_id, q.state, q.error, q.launches,
                      CASE WHEN b.revoked_at IS NULL THEN b.device_token END AS device_token
                 FROM queued_messages q
                 LEFT JOIN bearer_sessions b ON b.session_id = q.sender_session_id
                WHERE q.mend_user_id = ?
                ORDER BY q.mend_session_id, q.position`,
            )
            .all(mendUserId),
        ).pipe(Effect.flatMap(decoded("loadQueues", decodeQueuedRows)));
        const holds = yield* run("loadQueues", () =>
          database
            .prepare("SELECT mend_session_id FROM queue_holds WHERE mend_user_id = ?")
            .all(mendUserId),
        ).pipe(Effect.flatMap(decoded("loadQueues", decodeHoldRows)));
        const held = new Set(holds.map((row) => row.mend_session_id));
        const bySession = new Map<
          string,
          { entries: Array<StoredEntry>; senders: Map<string, string> }
        >();
        for (const row of rows) {
          const fresh: { entries: Array<StoredEntry>; senders: Map<string, string> } = {
            entries: [],
            senders: new Map(),
          };
          const kept = bySession.get(row.mend_session_id) ?? fresh;
          const state: EntryState = row.state;
          kept.entries.push({
            runId: row.run_id,
            messageId: row.message_id,
            text: row.text,
            requestedAt: row.requested_at,
            sender: row.sender_session_id,
            state,
            error: row.error,
            launches: row.launches,
          });
          if (row.device_token !== null) kept.senders.set(row.sender_session_id, row.device_token);
          bySession.set(row.mend_session_id, kept);
        }
        for (const sessionId of held) {
          if (!bySession.has(sessionId))
            bySession.set(sessionId, { entries: [], senders: new Map() });
        }
        return Array.from(bySession, ([sessionId, kept]) => ({
          sessionId,
          queue: { held: held.has(sessionId), entries: kept.entries },
          senders: kept.senders,
        }));
      });

    const reserveSequences = (from: number, count: number) =>
      run("reserveSequences", () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(SEQUENCE_HIGH);
          const high =
            row === undefined ? Date.now() : Number(Schema.decodeUnknownSync(MetaRow)(row).value);
          const start = Math.max(high, from);
          database
            .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
            .run(SEQUENCE_HIGH, String(start + count));
          database.exec("COMMIT");
          return start;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });

    const peopleWithQueuedMessages = () =>
      run("peopleWithQueuedMessages", () =>
        database
          .prepare(
            `SELECT b.* FROM bearer_sessions b
               JOIN (SELECT DISTINCT q.mend_user_id, q.sender_session_id FROM queued_messages q
                      WHERE q.state IN ('queued', 'launching')) p
                 ON p.sender_session_id = b.session_id AND p.mend_user_id = b.mend_user_id
              WHERE b.revoked_at IS NULL`,
          )
          .all(),
      ).pipe(
        Effect.flatMap(decoded("peopleWithQueuedMessages", decodeSessionRows)),
        Effect.map((rows) => rows.map(toBearerSession)),
      );

    return {
      environmentId,
      insertSession,
      findSession,
      findSessionById,
      revokeSession,
      revokeSessionsForDevice,
      recordTurnIds,
      listTurnIds,
      recordThread,
      listThreads,
      forgetThread,
      keepRemoval,
      listRemovals,
      dropRemoval,
      saveQueue,
      loadQueues,
      reserveSequences,
      peopleWithQueuedMessages,
    };
  });

/** The state file at the configured path. */
export const GatewayStateLive: Layer.Layer<GatewayState, GatewayStateError, GatewayConfig> =
  Layer.effect(
    GatewayState,
    Effect.gen(function* () {
      const config = yield* GatewayConfig;
      return yield* openGatewayState(config.statePath);
    }),
  );
