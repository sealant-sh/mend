import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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

/**
 * The gateway's own state (ADR 0012, "State"): one `node:sqlite` file it owns. Mend's records stay
 * in Mend; losing this file loses only the environment id, paired bearers and t3code-side ids.
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
  }
>()("@mend/t3-gateway/GatewayState") {}

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Migrations by `PRAGMA user_version`. Append only. t3code shows Mend's projects and sessions by
 * their Mend ids, so `project_ids` and `thread_ids` stay empty until a t3code client creates a
 * thread (phase 2). `message_ids` and `run_ids` carry the ids of every turn a t3code client sent,
 * keyed by the Mend turn: a message id comes from the client, so it is never a key across
 * sessions, and a recorded turn is never replaced (migration 3).
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
];

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

/** Opens (or creates) the state file at `path`, migrated, and closes it with the scope. */
export const openGatewayState = (
  path: string,
): Effect.Effect<GatewayState["Service"], GatewayStateError, Scope.Scope> =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
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

    return {
      environmentId,
      insertSession,
      findSession,
      findSessionById,
      revokeSession,
      revokeSessionsForDevice,
      recordTurnIds,
      listTurnIds,
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
