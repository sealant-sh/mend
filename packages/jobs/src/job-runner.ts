import { Config, Effect, Layer, Redacted, Schema } from "effect";
import * as Context from "effect/Context";
import { PgBoss } from "pg-boss";

export class JobEnqueueError extends Schema.TaggedErrorClass<JobEnqueueError>()("JobEnqueueError", {
  job: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface JobSpec {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  /**
   * Structural, per ARCHITECTURE.md §5: `compose-tour:{change_id}`,
   * `brief:{change_id}:{head_sha}`. While a job with the same name and key is
   * queued, waiting to retry or running, another enqueue with it is dropped
   * (`enqueue` answers null). Once that job has completed or failed, the key
   * starts a new one. The live layer checks before it sends: pg-boss's
   * `standard` queues ignore `singletonKey` without `singletonSeconds`, and a
   * queue's policy cannot change once it exists.
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
  static readonly pgBossLayer = Layer.effect(
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

      // pg-boss v10+ requires queues to exist before send/work.
      const knownQueues = new Set<string>();
      const ensureQueue = (name: string) =>
        knownQueues.has(name)
          ? Effect.void
          : Effect.promise(async () => {
              await boss.createQueue(name);
              knownQueues.add(name);
            });

      /** Whether a job with this name and key is still queued, retrying or running. */
      const keyIsLive = (name: string, key: string) =>
        Effect.tryPromise({
          try: () => boss.findJobs(name, { key }),
          catch: (cause) => new JobEnqueueError({ job: name, cause }),
        }).pipe(Effect.map((found) => found.some((job) => LIVE_JOB_STATES.has(job.state))));

      const enqueue = Effect.fn("JobRunner.enqueue")(function* (job: JobSpec) {
        yield* ensureQueue(job.name).pipe(
          Effect.catchDefect((cause) => new JobEnqueueError({ job: job.name, cause })),
        );
        if (job.idempotencyKey !== undefined && (yield* keyIsLive(job.name, job.idempotencyKey))) {
          yield* Effect.logDebug("jobs: enqueue dropped · the key's job is still live").pipe(
            Effect.annotateLogs({ job: job.name, key: job.idempotencyKey }),
          );
          return null;
        }
        return yield* Effect.tryPromise({
          try: () =>
            boss.send(job.name, job.payload, {
              ...(job.idempotencyKey === undefined ? {} : { singletonKey: job.idempotencyKey }),
              ...(job.startAfterSeconds === undefined ? {} : { startAfter: job.startAfterSeconds }),
              ...(job.retryDelaySeconds === undefined ? {} : { retryDelay: job.retryDelaySeconds }),
              retryLimit: job.retryLimit ?? 3,
              retryBackoff: true,
            }),
          catch: (cause) => new JobEnqueueError({ job: job.name, cause }),
        });
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
              const started = Date.now();
              await Effect.runPromise(
                Effect.annotateLogs(Effect.logInfo("job started"), {
                  job: name,
                  jobId: job.id,
                }).pipe(
                  Effect.andThen(handler(job.data)),
                  Effect.tap(() =>
                    Effect.annotateLogs(Effect.logInfo("job completed"), {
                      job: name,
                      jobId: job.id,
                      durationMs: Date.now() - started,
                    }),
                  ),
                  Effect.tapDefect((cause) =>
                    Effect.annotateLogs(
                      Effect.logError(
                        "job failed — pg-boss retries until the limit, then dead-letters",
                      ),
                      {
                        job: name,
                        jobId: job.id,
                        durationMs: Date.now() - started,
                        cause: String(cause),
                      },
                    ),
                  ),
                ),
              );
            }
          }),
        );
      });

      return { enqueue, work };
    }),
  );

  /**
   * In-memory engine for tests: enqueue runs the registered handler inline, and a key, once seen,
   * drops every later enqueue with it (the live layer frees it when its job completes).
   */
  static readonly testLayer = Layer.sync(JobRunner, () => {
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
}
