import { AgentTurnId, ChangeId, ProjectId, ProofArtifactId, SessionId } from "@mend/domain";
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

/** Controls captured after the reporter has posted the agent's closing reply. */
export const SlackProofTurnContext = Schema.Struct({
  projectId: ProjectId,
  changeId: Schema.NullOr(ChangeId),
  url: Schema.String,
  previewUrl: Schema.NullOr(Schema.String),
  push: Schema.NullOr(Schema.Struct({ sessionId: SessionId, updates: Schema.Boolean })),
});
export type SlackProofTurnContext = typeof SlackProofTurnContext.Type;

/** A completion is reserved durably before Slack is called, including its exact file set. */
export const SlackProofBatch = Schema.Struct({
  artifactIds: Schema.Array(ProofArtifactId),
  startedAt: Schema.NullOr(Schema.Number),
  finished: Schema.Boolean,
  messageTs: Schema.NullOr(Schema.String),
  replyStarted: Schema.Boolean,
});
export type SlackProofBatch = typeof SlackProofBatch.Type;

/** Turn batches preserve their membership across retries and late captures. */
export const SlackProofTurnProgress = Schema.Struct({ batches: Schema.Array(SlackProofBatch) });
export type SlackProofTurnProgress = typeof SlackProofTurnProgress.Type;

/** One serialized writer owns a turn's messages and each file's existing delivery record. */
export interface SlackProofTurnStore {
  readonly context: SlackProofTurnContext | null;
  readonly read: () => Effect.Effect<SlackProofTurnProgress, SlackProofDeliveryError>;
  readonly save: (progress: SlackProofTurnProgress) => Effect.Effect<void, SlackProofDeliveryError>;
  readonly file: (
    id: ProofArtifactId,
  ) => Effect.Effect<SlackProofDeliveryStore, SlackProofDeliveryError>;
}

/** Serializes delivery while each progress write commits before the next Slack call. */
export class SlackProofDeliveriesRepo extends Context.Service<
  SlackProofDeliveriesRepo,
  {
    /** Marks the agent reply complete before any capture message can be sent. */
    readonly readyTurn: (
      sessionId: SessionId,
      turnId: AgentTurnId,
      context: SlackProofTurnContext,
    ) => Effect.Effect<void, SlackProofDeliveryError>;
    /** Recovery includes the reply/enqueue gap and captures settling after their first batch. */
    readonly pendingTurns: (
      since: Date,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly sessionId: SessionId; readonly turnId: AgentTurnId }>,
      SlackProofDeliveryError
    >;
    readonly withTurn: <A, E, R>(
      key: { readonly sessionId: SessionId; readonly turnId: AgentTurnId },
      use: (store: SlackProofTurnStore) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SlackProofDeliveryError, R>;
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
      readyTurn: (sessionId, turnId, context) =>
        sql`INSERT INTO slack_proof_turns (session_id, turn_id, context) VALUES (${sessionId}, ${turnId}, ${JSON.stringify(context)}::jsonb)
        ON CONFLICT (session_id, turn_id) DO UPDATE SET context = excluded.context`.pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new SlackProofDeliveryError({
                operation: "readyTurn",
                message: "Slack turn could not be queued.",
              }),
          ),
        ),
      pendingTurns: (since) =>
        sql`SELECT session_id AS "sessionId", turn_id AS "turnId" FROM slack_proof_turns WHERE created_at >= ${since} AND context IS NOT NULL`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ sessionId: SessionId, turnId: AgentTurnId })),
            ),
          ),
          Effect.mapError(
            () =>
              new SlackProofDeliveryError({
                operation: "pendingTurns",
                message: "Slack turns could not be reconciled.",
              }),
          ),
        ),
      withTurn: (key, use) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sql.reserve.pipe(
              Effect.mapError(
                () =>
                  new SlackProofDeliveryError({
                    operation: "connect",
                    message: "Slack turn connection unavailable.",
                  }),
              ),
            );
            const lockKey = `mend:slack-proof-turn:${key.sessionId}:${key.turnId}`;
            const execute = (query: string, params: ReadonlyArray<unknown>) =>
              connection.execute(query, params, undefined).pipe(
                Effect.mapError(
                  () =>
                    new SlackProofDeliveryError({
                      operation: "turn",
                      message: "Slack turn progress unavailable.",
                    }),
                ),
              );
            return yield* Effect.acquireUseRelease(
              execute("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [
                lockKey,
              ]).pipe(
                Effect.flatMap((rows) =>
                  rows[0]?.["locked"] === true
                    ? Effect.void
                    : Effect.fail(
                        new SlackProofDeliveryError({
                          operation: "busy",
                          message: "Slack turn is already being delivered.",
                        }),
                      ),
                ),
              ),
              () =>
                Effect.gen(function* () {
                  yield* execute(
                    "INSERT INTO slack_proof_turns (session_id, turn_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                    [key.sessionId, key.turnId],
                  );
                  const read = () =>
                    execute(
                      "SELECT context, progress FROM slack_proof_turns WHERE session_id = $1 AND turn_id = $2",
                      [key.sessionId, key.turnId],
                    ).pipe(
                      Effect.flatMap(
                        Schema.decodeUnknownEffect(
                          Schema.NonEmptyArray(
                            Schema.Struct({
                              context: Schema.NullOr(SlackProofTurnContext),
                              progress: SlackProofTurnProgress,
                            }),
                          ),
                        ),
                      ),
                      Effect.map((rows) => rows[0]),
                      Effect.mapError(
                        () =>
                          new SlackProofDeliveryError({
                            operation: "readTurn",
                            message: "Slack turn progress unavailable.",
                          }),
                      ),
                    );
                  const row = yield* read();
                  return yield* use({
                    context: row.context,
                    read: () => read().pipe(Effect.map((current) => current.progress)),
                    save: (progress) =>
                      execute(
                        "UPDATE slack_proof_turns SET progress = $3::jsonb WHERE session_id = $1 AND turn_id = $2",
                        [key.sessionId, key.turnId, JSON.stringify(progress)],
                      ).pipe(Effect.asVoid),
                    file: (id) =>
                      execute(
                        "INSERT INTO slack_proof_deliveries (session_id, artifact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                        [key.sessionId, id],
                      ).pipe(
                        Effect.as(
                          storeOn(connection, { sessionId: key.sessionId, artifactId: id }),
                        ),
                      ),
                  });
                }),
              () =>
                execute("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).pipe(
                  Effect.orDie,
                ),
            );
          }),
        ),
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
