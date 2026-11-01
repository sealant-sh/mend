import { ProofArtifactId, SessionId } from "@mend/domain";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { SqlClient } from "effect/sql";
import type { Connection } from "effect/sql/SqlConnection";

export const SlackProofDeliveryState = Schema.Literals([
  "reserved",
  "uploaded",
  "shared",
  "withheld",
  "failed",
]);

/** Durable progress for one artifact in its contributing session's Slack thread. */
export const SlackProofDelivery = Schema.Struct({
  sessionId: SessionId,
  artifactId: ProofArtifactId,
  slackFileId: Schema.NullOr(Schema.String),
  uploadUrl: Schema.NullOr(Schema.String),
  state: SlackProofDeliveryState,
  messageTs: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  attempts: Schema.Int,
  completionStartedAt: Schema.NullOr(Schema.Date),
  replyStartedAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});
export type SlackProofDelivery = typeof SlackProofDelivery.Type;

export interface SlackProofDeliveryKey {
  readonly sessionId: SessionId;
  readonly artifactId: ProofArtifactId;
}

/** The next durable state; attempts and timestamps belong to the repository. */
export type SlackProofDeliveryProgress = Pick<
  SlackProofDelivery,
  | "slackFileId"
  | "uploadUrl"
  | "state"
  | "messageTs"
  | "errorCode"
  | "completionStartedAt"
  | "replyStartedAt"
>;

export class SlackProofDeliveryError extends Schema.TaggedError<SlackProofDeliveryError>()(
  "SlackProofDeliveryError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface SlackProofDeliveryStore {
  readonly read: () => Effect.Effect<SlackProofDelivery, SlackProofDeliveryError>;
  readonly startAttempt: () => Effect.Effect<SlackProofDelivery, SlackProofDeliveryError>;
  readonly save: (
    progress: SlackProofDeliveryProgress,
  ) => Effect.Effect<SlackProofDelivery, SlackProofDeliveryError>;
}

/** Serializes delivery while each progress write commits before the next Slack call. */
export class SlackProofDeliveriesRepo extends Context.Service<
  SlackProofDeliveriesRepo,
  {
    /** Settled artifacts in Slack threads without a terminal delivery, ordered for recovery. */
    readonly pendingSince: (
      since: Date,
    ) => Effect.Effect<ReadonlyArray<ProofArtifactId>, SlackProofDeliveryError>;
    readonly withDelivery: <A, E, R>(
      key: SlackProofDeliveryKey,
      use: (store: SlackProofDeliveryStore) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SlackProofDeliveryError, R>;
  }
>()("@mend/db/SlackProofDeliveriesRepo") {}

const columns = `session_id AS "sessionId", artifact_id AS "artifactId", slack_file_id AS "slackFileId",
  upload_url AS "uploadUrl", state, message_ts AS "messageTs", error_code AS "errorCode", attempts,
  completion_started_at AS "completionStartedAt", reply_started_at AS "replyStartedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const storeOn = (connection: Connection, key: SlackProofDeliveryKey): SlackProofDeliveryStore => {
  const query = (operation: string, statement: string, params: ReadonlyArray<unknown>) =>
    connection.execute(statement, params, undefined).pipe(
      Effect.mapError(
        () =>
          new SlackProofDeliveryError({
            operation,
            message: "Slack proof delivery could not be saved or read.",
          }),
      ),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(Schema.NonEmptyArray(SlackProofDelivery))(rows),
      ),
      Effect.mapError(
        () =>
          new SlackProofDeliveryError({
            operation,
            message: "Slack proof delivery could not be saved or read.",
          }),
      ),
      Effect.map((rows) => rows[0]),
    );
  const ids = [key.sessionId, key.artifactId];
  return {
    read: () =>
      query(
        "read",
        `SELECT ${columns} FROM slack_proof_deliveries WHERE session_id = $1 AND artifact_id = $2`,
        ids,
      ),
    startAttempt: () =>
      query(
        "startAttempt",
        `UPDATE slack_proof_deliveries SET attempts = attempts + 1, updated_at = now() WHERE session_id = $1 AND artifact_id = $2 RETURNING ${columns}`,
        ids,
      ),
    save: (progress) =>
      query(
        "save",
        `UPDATE slack_proof_deliveries SET slack_file_id = $3, upload_url = $4,
      state = $5, message_ts = $6, error_code = $7, completion_started_at = $8, reply_started_at = $9, updated_at = now()
      WHERE session_id = $1 AND artifact_id = $2 RETURNING ${columns}`,
        [
          ...ids,
          progress.slackFileId,
          progress.uploadUrl,
          progress.state,
          progress.messageTs,
          progress.errorCode,
          progress.completionStartedAt,
          progress.replyStartedAt,
        ],
      ),
  };
};

export const SlackProofDeliveriesRepoLive: Layer.Layer<
  SlackProofDeliveriesRepo,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  SlackProofDeliveriesRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return SlackProofDeliveriesRepo.of({
      pendingSince: (since) =>
        sql`SELECT a.id FROM proof_artifacts a
          JOIN slack_threads t ON t.session_id = a.session_id
          WHERE a.created_at >= ${since}
            AND a.capture->>'_tag' IN ('Screenshot', 'Video', 'NotCaptured')
            AND NOT EXISTS (
              SELECT 1 FROM slack_proof_deliveries d
              WHERE d.session_id = a.session_id AND d.artifact_id = a.id
                AND d.state IN ('shared', 'withheld', 'failed')
            )
          ORDER BY a.created_at, a.id`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: ProofArtifactId }))),
          ),
          Effect.map((rows) => rows.map((row) => row.id)),
          Effect.mapError(
            () =>
              new SlackProofDeliveryError({
                operation: "pendingSince",
                message: "Slack proof deliveries could not be reconciled.",
              }),
          ),
        ),
      withDelivery: (key, use) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve.pipe(
              Effect.mapError(
                () =>
                  new SlackProofDeliveryError({
                    operation: "connect",
                    message: "Slack proof delivery could not open its database connection.",
                  }),
              ),
            );
            const lockKey = `mend:slack-proof:${key.sessionId}:${key.artifactId}`;
            // A session lock keeps the same connection without a transaction spanning the upload.
            // Try rather than wait, so queued deliveries cannot occupy the entire pool.
            return yield* Effect.acquireUseRelease(
              connection
                .executeValues("SELECT pg_try_advisory_lock(hashtextextended($1, 0))", [lockKey])
                .pipe(
                  Effect.mapError(
                    () =>
                      new SlackProofDeliveryError({
                        operation: "lock",
                        message: "Slack proof delivery could not acquire its lock.",
                      }),
                  ),
                  Effect.flatMap((rows) =>
                    rows[0]?.[0] === true
                      ? Effect.void
                      : Effect.fail(
                          new SlackProofDeliveryError({
                            operation: "busy",
                            message: "Slack proof delivery is already running.",
                          }),
                        ),
                  ),
                ),
              () =>
                Effect.gen(function* () {
                  yield* connection
                    .executeRaw(
                      "INSERT INTO slack_proof_deliveries (session_id, artifact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                      [key.sessionId, key.artifactId],
                    )
                    .pipe(
                      Effect.mapError(
                        () =>
                          new SlackProofDeliveryError({
                            operation: "reserve",
                            message: "Slack proof delivery could not reserve its record.",
                          }),
                      ),
                    );
                  return yield* use(storeOn(connection, key));
                }),
              () =>
                connection
                  .executeRaw("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey])
                  .pipe(Effect.orDie),
            );
          }),
        ),
    });
  }),
);
