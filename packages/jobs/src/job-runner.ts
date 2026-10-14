import { Clock, Config, Effect, Layer, Redacted, Schema } from "effect";
import * as Context from "effect/Context";
import { Pool } from "pg";
import { PgBoss, type Db } from "pg-boss";

export class JobEnqueueError extends Schema.TaggedErrorClass<JobEnqueueError>()("JobEnqueueError", {
  job: Schema.String,
  cause: Schema.Defect(),
}) {}

class JobRollbackError extends Schema.TaggedErrorClass<JobRollbackError>()("JobRollbackError", {
  cause: Schema.Defect(),
  rollbackCause: Schema.Defect(),
}) {
  override readonly message = "jobs: enqueue rollback failed";
}

export interface JobSpec {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  /**
   * Structural, per ARCHITECTURE.md §5: `compose-tour:{change_id}`,
   * `brief:{change_id}:{head_sha}`. While a job with the same name and key is
   * queued, waiting to retry or running, another enqueue with it is dropped
   * (`enqueue` answers null). Once that job has completed or failed, the key
   * starts a new one. The live layer locks this name and key in a database
   * transaction before checking and sending. Existing standard queues and
   * their jobs remain in place.
   */
  readonly idempotencyKey?: string;
  readonly retryLimit?: number;
  /** Delay before the first attempt runs (e.g. give a fresh session time to receive a prompt). */
  readonly startAfterSeconds?: number;
  /** Base retry delay; with the engine's exponential backoff this spaces retries out over minutes. */
  readonly retryDelaySeconds?: number;
}

export interface WorkOptions {
  /**
   * How many jobs of this name one process runs at once. pg-boss runs one by default, so a single
   * long pass (a tour composing for minutes) holds every other change's pass behind it.
   */
  readonly localConcurrency?: number;
}

/** The states in which a job still holds its idempotency key. */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set(["created", "retry", "active"]);

/**
 * The seam over the side-effect job engine. pg-boss is the live layer today;
 * if it ever disappoints, the engine is a layer swap — nothing upstream knows
 * about it (ARCHITECTURE.md §5).
 */
export class JobRunner extends Context.Service<
  JobRunner,
  {
    /** Returns the job id, or null when a live job with the same key absorbed it. */
    readonly enqueue: (job: JobSpec) => Effect.Effect<string | null, JobEnqueueError>;
    /**
     * Register the worker for a job name. Handlers arrive fully provided
     * (R = never); a failed handler fails the job into pg-boss retry, and the
     * dead letter after `retryLimit` stays visible in the jobs schema.
     */
    readonly work: (
      name: string,
      handler: (payload: unknown) => Effect.Effect<void>,
      options?: WorkOptions,
    ) => Effect.Effect<void>;
  }
>()("@mend/jobs/JobRunner") {
  /** Compatibility entrypoint for existing composition roots. */
  static get pgBossLayer(): Layer.Layer<JobRunner, Config.ConfigError> {
    return JobRunnerLive;
  }

  /** Compatibility entrypoint for the existing inline test engine. */
  static get testLayer(): Layer.Layer<JobRunner> {
    return JobRunnerTest;
  }
}

/** PostgreSQL jobs with transaction-scoped exclusion of concurrent live keys. */
export const JobRunnerLive: Layer.Layer<JobRunner, Config.ConfigError> = Layer.effect(
  JobRunner,
  Effect.gen(function* () {
    const databaseUrl = yield* Config.redacted("DATABASE_URL").pipe(
      Config.orElse(() =>
        Config.succeed(Redacted.make("postgres://mend:mend@localhost:5434/mend")),
      ),
    );

    const poolMax = yield* Config.int("MEND_JOBS_POOL_MAX").pipe(Config.withDefault(3));

    const boss = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const instance = new PgBoss({
          connectionString: Redacted.value(databaseUrl),
          application_name: "mend-jobs",
          max: poolMax,
        });
        // pg-boss reports a failed poll or maintenance run as an `error` event and retries on
        // its own. Node treats an `error` event with no listener as fatal, so without this a
        // refused connection ("remaining connection slots are reserved") exits the API.
        instance.on("error", (error) => {
          Effect.runFork(
            Effect.logError("jobs: pg-boss error").pipe(
              Effect.annotateLogs({ error: error.message }),
            ),
          );
        });
        instance.on("warning", (warning) => {
          Effect.runFork(
            Effect.logWarning("jobs: pg-boss warning").pipe(
              Effect.annotateLogs({ warning: warning.message }),
            ),
          );
        });
        await instance.start();
        return instance;
      }),
      (instance) => Effect.promise(() => instance.stop({ close: true })),
    );

    const enqueuePoolMax = yield* Config.schema(
      Schema.Int.check(Schema.isGreaterThan(0)),
      "MEND_JOBS_ENQUEUE_POOL_MAX",
    ).pipe(Config.withDefault(1));
    // These connections only hold short enqueue transactions. Worker polling stays in pg-boss's
    // own pool, so its queue metadata lookup cannot wait on a connection held by this transaction.
    const enqueuePool = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const pool = new Pool({
          connectionString: Redacted.value(databaseUrl),
          application_name: "mend-jobs-enqueue",
          max: enqueuePoolMax,
          connectionTimeoutMillis: 5000,
          statement_timeout: 5000,
          lock_timeout: 5000,
          query_timeout: 5000,
          idle_in_transaction_session_timeout: 5000,
        });
        pool.on("error", (error) => {
          Effect.runFork(
            Effect.logError("jobs: enqueue pool error").pipe(
              Effect.annotateLogs({ error: error.message }),
            ),
          );
        });
        return pool;
      }),
      (pool) => Effect.promise(() => pool.end()),
    );

    // pg-boss v10+ requires queues to exist before send/work.
    const knownQueues = new Map<string, Promise<void>>();
    const ensureQueue = (name: string) =>
      Effect.promise(() => {
        const known = knownQueues.get(name);
        if (known !== undefined) return known;
        const ready = (async () => {
          await boss.createQueue(name);
          // Prime pg-boss's metadata cache before taking a transaction connection. Only the
          // lookup and insert below belong in that bounded critical section.
          await boss.findJobs(name, { id: "00000000-0000-0000-0000-000000000000" });
        })().catch((cause: unknown) => {
          knownQueues.delete(name);
          throw cause;
        });
        knownQueues.set(name, ready);
        return ready;
      });

    const send = (job: JobSpec, db?: Db) =>
      boss.send(job.name, job.payload, {
        ...(db === undefined ? {} : { db }),
        ...(job.idempotencyKey === undefined ? {} : { singletonKey: job.idempotencyKey }),
        ...(job.startAfterSeconds === undefined ? {} : { startAfter: job.startAfterSeconds }),
        ...(job.retryDelaySeconds === undefined ? {} : { retryDelay: job.retryDelaySeconds }),
        retryLimit: job.retryLimit ?? 3,
        retryBackoff: true,
      });

    const enqueueKeyed = async (job: JobSpec, key: string) => {
      const client = await enqueuePool.connect();
      // pg accepts query_timeout per query, although @types/pg only declares it on ClientConfig.
      // A URL can override the client defaults, so every query and the server transaction get bounds.
      const query = (text: string, values?: unknown[]) => {
        const config = { text, values, query_timeout: 5000 };
        return client.query<Record<string, unknown>>(config);
      };
      let discard = false;
      try {
        // A lock waiter must observe its predecessor's committed insert on the next statement.
        await query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await query("SET LOCAL statement_timeout = '5s'");
        await query("SET LOCAL lock_timeout = '5s'");
        await query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
        // JSON frames arbitrary names/keys without separator collisions. Hash collisions only
        // serialize unrelated keys; they cannot admit duplicate live jobs.
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify(["mend-live-job-v1", "pgboss", job.name, key]),
        ]);
        const db: Db = {
          executeSql: query,
        };
        const found = await boss.findJobs(job.name, { key, db });
        const result = found.some((item) => LIVE_JOB_STATES.has(item.state))
          ? null
          : await send(job, db);
        await query("COMMIT");
        return result;
      } catch (cause) {
        discard = true;
        try {
          await query("ROLLBACK");
        } catch (rollbackCause) {
          throw new JobRollbackError({ cause, rollbackCause });
        }
        throw cause;
      } finally {
        client.release(discard);
      }
    };

    const enqueue = Effect.fn("JobRunner.enqueue")(function* (job: JobSpec) {
      yield* ensureQueue(job.name).pipe(
        Effect.catchDefect((cause) => new JobEnqueueError({ job: job.name, cause })),
      );
      const key = job.idempotencyKey;
      const request = Effect.tryPromise({
        try: () => (key === undefined ? send(job) : enqueueKeyed(job, key)),
        catch: (cause) => new JobEnqueueError({ job: job.name, cause }),
      });
      // Await the bounded transaction's commit/rollback and release before honoring interruption.
      // Returning early from an uncancelled pg Promise could leave a lock or insert running.
      // Capture failures inside the mask, then replay outside it so a pending abort is observed.
      const result = yield* key === undefined
        ? request
        : Effect.uninterruptible(Effect.exit(request)).pipe(Effect.flatMap((exit) => exit));
      if (result === null) {
        yield* Effect.logDebug("jobs: enqueue dropped · the key's job is still live").pipe(
          Effect.annotateLogs({ job: job.name, key }),
        );
      }
      return result;
    });

    const work = Effect.fn("JobRunner.work")(function* (
      name: string,
      handler: (payload: unknown) => Effect.Effect<void>,
      options?: WorkOptions,
    ) {
      yield* ensureQueue(name).pipe(Effect.orDie);
      yield* Effect.promise(() =>
        boss.work(name, { localConcurrency: options?.localConcurrency ?? 1 }, async (jobs) => {
          for (const job of jobs) {
            // The handler's death must still fail the job into pg-boss
            // retry — but never silently. Without these taps the reason
            // lives only in the jobs table, and the server log shows a
            // clean 200 for the enqueue and then nothing at all.
            await Effect.runPromise(
              Effect.flatMap(Clock.currentTimeMillis, (started) => {
                const elapsed = Clock.currentTimeMillis.pipe(Effect.map((at) => at - started));
                return Effect.annotateLogs(Effect.logInfo("job started"), {
                  job: name,
                  jobId: job.id,
                }).pipe(
                  Effect.andThen(handler(job.data)),
                  Effect.tap(() =>
                    Effect.flatMap(elapsed, (durationMs) =>
                      Effect.annotateLogs(Effect.logInfo("job completed"), {
                        job: name,
                        jobId: job.id,
                        durationMs,
                      }),
                    ),
                  ),
                  Effect.tapDefect((cause) =>
                    Effect.flatMap(elapsed, (durationMs) =>
                      Effect.annotateLogs(
                        Effect.logError(
                          "job failed — pg-boss retries until the limit, then dead-letters",
                        ),
                        {
                          job: name,
                          jobId: job.id,
                          durationMs,
                          cause: String(cause),
                        },
                      ),
                    ),
                  ),
                );
              }),
            );
          }
        }),
      );
    });

    return { enqueue, work };
  }),
);

/**
 * Existing inline test engine. A seen key remains consumed after its handler completes;
 * PostgreSQL lifecycle guarantees are exercised through JobRunnerLive.
 */
export const JobRunnerTest: Layer.Layer<JobRunner> = Layer.sync(JobRunner, () => {
  const handlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
  const seenKeys = new Set<string>();

  const enqueue = (job: JobSpec): Effect.Effect<string | null, JobEnqueueError> =>
    Effect.gen(function* () {
      if (job.idempotencyKey !== undefined) {
        if (seenKeys.has(job.idempotencyKey)) return null;
        seenKeys.add(job.idempotencyKey);
      }
      const handler = handlers.get(job.name);
      if (handler !== undefined) yield* handler(job.payload);
      return crypto.randomUUID();
    });

  const work = (name: string, handler: (payload: unknown) => Effect.Effect<void>) =>
    Effect.sync(() => void handlers.set(name, handler));

  return { enqueue, work };
});
