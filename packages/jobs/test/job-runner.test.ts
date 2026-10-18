import { PgClient } from "@effect/sql-pg";
import { postgresTestConfig } from "@mend/db/testing";
import { it } from "@mend/test-ci/effect-vitest";
import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import { SqlClient } from "effect/sql";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { JobRunner, type JobSpec } from "../src/job-runner.ts";

/**
 * Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out.
 * pg-boss, its pool and PostgreSQL's own timeouts run on real time, so every case is `it.live`.
 */
const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_jobs_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(adminLayer), Effect.scoped);
const withScratch = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(scratchLayer), Effect.scoped);
const makeJobs = (databaseUrl = scratchUrl) =>
  ManagedRuntime.make(
    JobRunner.pgBossLayer.pipe(
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ DATABASE_URL: databaseUrl })),
      ),
      Layer.orDie,
    ),
  );
type Jobs = ManagedRuntime.ManagedRuntime<JobRunner, never>;
const enqueueWith = (runner: Jobs, job: JobSpec) =>
  Effect.flatMap(runner.contextEffect, (context) =>
    Effect.flatMap(JobRunner, (service) => service.enqueue(job)).pipe(
      Effect.provideContext(context),
    ),
  );

const until = <E>(check: Effect.Effect<boolean, E>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (yield* check) return;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

describe.skipIf(postgres.skip)("JobRunner on pg-boss", () => {
  let runtime: Jobs | null = null;
  let otherRuntime: Jobs | null = null;
  let control: PgBoss | null = null;
  const boss = <A>(use: (client: PgBoss) => Promise<A>) =>
    Effect.promise(() => {
      if (control === null) throw new Error("control client not started");
      return use(control);
    });
  const jobs = () => {
    if (runtime === null) throw new Error("runtime not started");
    return runtime;
  };

  beforeAll(async () => {
    await Effect.runPromise(
      withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
        }),
      ),
    );
    runtime = makeJobs();
    otherRuntime = makeJobs();
    await runtime.runPromise(Effect.void);
    await otherRuntime.runPromise(Effect.void);
    control = new PgBoss({ connectionString: scratchUrl, supervise: false, schedule: false });
    control.on("error", (error) => console.error(error.message));
    await control.start();
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    await otherRuntime?.dispose();
    await control?.stop({ close: true });
    await Effect.runPromise(
      withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
        }),
      ),
    );
  });

  const enqueue = (job: JobSpec, second = false) => {
    const runner = second ? otherRuntime : runtime;
    if (runner === null) throw new Error("runtime not started");
    return enqueueWith(runner, job);
  };

  const stateOf = (name: string, id: string) =>
    boss((client) => client.findJobs(name, { id })).pipe(Effect.map((rows) => rows[0]?.state));

  it.live("an active job and its delayed retry keep the key", () =>
    Effect.gen(function* () {
      const job = {
        name: "dedup-retry",
        payload: { first: true },
        idempotencyKey: "held-key",
        retryDelaySeconds: 60,
        retryLimit: 1,
      };
      const id = yield* enqueue(job);
      if (id === null) throw new Error("first enqueue was absorbed");
      expect((yield* boss((client) => client.fetch(job.name))).map((row) => row.id)).toEqual([id]);
      expect(yield* stateOf(job.name, id)).toBe("active");
      expect(yield* enqueue({ ...job, payload: { first: false } }, true)).toBeNull();
      yield* boss((client) => client.fail(job.name, id));
      expect(yield* stateOf(job.name, id)).toBe("retry");
      expect(yield* enqueue(job, true)).toBeNull();
      expect(
        (yield* boss((client) => client.findJobs(job.name, { key: job.idempotencyKey }))).map(
          (row) => row.data,
        ),
      ).toEqual([{ first: true }]);
    }),
  );

  it.live.each(["completed", "failed", "cancelled"] as const)(
    "%s releases a key without removing its historical row",
    (terminal) =>
      Effect.gen(function* () {
        const job = {
          name: `dedup-${terminal}`,
          payload: {},
          idempotencyKey: "released-key",
          retryLimit: 0,
        };
        const id = yield* enqueue(job);
        if (id === null) throw new Error("first enqueue was absorbed");
        yield* boss((client) => client.fetch(job.name));
        if (terminal === "completed") yield* boss((client) => client.complete(job.name, id));
        else if (terminal === "failed") yield* boss((client) => client.fail(job.name, id));
        else yield* boss((client) => client.cancel(job.name, id));
        expect(yield* stateOf(job.name, id)).toBe(terminal);
        const replacement = yield* enqueue(job, true);
        expect(replacement).not.toBeNull();
        expect(replacement).not.toBe(id);
        expect(yield* stateOf(job.name, id)).toBe(terminal);
        const rows = yield* boss((client) =>
          client.findJobs(job.name, { key: job.idempotencyKey }),
        );
        expect(
          rows.filter((row) => ["created", "retry", "active"].includes(row.state)),
        ).toHaveLength(1);
      }),
  );

  it.live("keeps distinct names and keys independent, and accepts every keyless enqueue", () =>
    Effect.gen(function* () {
      const distinct = yield* Effect.all(
        [
          enqueue({ name: "dedup-distinct", payload: {}, idempotencyKey: "one" }),
          enqueue({ name: "dedup-distinct", payload: {}, idempotencyKey: "two" }, true),
          enqueue({ name: "dedup-other-name", payload: {}, idempotencyKey: "one" }, true),
        ],
        { concurrency: "unbounded" },
      );
      expect(distinct.every((id) => id !== null)).toBe(true);
      expect(new Set(distinct).size).toBe(3);
      const keyless = yield* Effect.all(
        Array.from({ length: 30 }, (_, index) =>
          enqueue({ name: "dedup-keyless", payload: { index } }, index % 2 === 1),
        ),
        { concurrency: "unbounded" },
      );
      expect(keyless.every((id) => id !== null)).toBe(true);
      expect(new Set(keyless).size).toBe(30);
      expect(yield* boss((client) => client.findJobs("dedup-keyless"))).toHaveLength(30);
    }),
  );

  it.live("honors a job already queued by an older standard-queue producer", () =>
    Effect.gen(function* () {
      const name = "dedup-existing-standard";
      yield* boss((client) => client.createQueue(name));
      const id = yield* boss((client) =>
        client.send(name, { legacy: true }, { singletonKey: "existing-key" }),
      );
      expect(id).not.toBeNull();
      expect(
        yield* enqueue({ name, payload: { legacy: false }, idempotencyKey: "existing-key" }),
      ).toBeNull();
      expect((yield* boss((client) => client.getQueue(name)))?.policy).toBe("standard");
      const rows = yield* boss((client) => client.findJobs(name, { key: "existing-key" }));
      expect(rows.map((row) => ({ id: row.id, data: row.data, state: row.state }))).toEqual([
        { id, data: { legacy: true }, state: "created" },
      ]);
    }),
  );

  it.live("an insert failure rolls back and releases its key for another runner", () =>
    Effect.gen(function* () {
      const job = { name: "dedup-rollback", payload: {}, idempotencyKey: "retry-after-failure" };
      yield* boss((client) => client.createQueue(job.name));
      yield* withScratch(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`
        CREATE FUNCTION reject_dedup_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name = 'dedup-rollback' THEN RAISE EXCEPTION 'deliberate enqueue failure'; END IF;
          RETURN NEW;
        END $$`);
          yield* sql.unsafe(`CREATE TRIGGER reject_dedup_insert BEFORE INSERT ON pgboss.job
        FOR EACH ROW EXECUTE FUNCTION reject_dedup_insert()`);
        }),
      );
      yield* Effect.gen(function* () {
        expect(yield* Effect.flip(enqueue(job))).toMatchObject({ _tag: "JobEnqueueError" });
        expect(
          yield* boss((client) => client.findJobs(job.name, { key: job.idempotencyKey })),
        ).toEqual([]);
        const locks = yield* withAdmin(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a USING (pid)
          WHERE a.datname = ${SCRATCH_DB} AND a.application_name = 'mend-jobs-enqueue'
            AND l.locktype = 'advisory'`;
          }),
        );
        expect(locks[0]?.count).toBe(0);
      }).pipe(
        Effect.ensuring(
          withScratch(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe("DROP TRIGGER reject_dedup_insert ON pgboss.job");
              yield* sql.unsafe("DROP FUNCTION reject_dedup_insert()");
            }),
          ).pipe(Effect.orDie),
        ),
      );
      expect(yield* enqueue(job, true)).not.toBeNull();
      expect(
        yield* boss((client) => client.findJobs(job.name, { key: job.idempotencyKey })),
      ).toHaveLength(1);
    }),
  );

  it.live.each([
    { interrupted: false, label: "blocked", urlTimeouts: false },
    { interrupted: true, label: "interrupted", urlTimeouts: false },
    { interrupted: false, label: "url-timeouts", urlTimeouts: true },
  ])(
    "a $label key waiter finishes rollback before returning and leaves other keys free",
    ({ interrupted, label, urlTimeouts }) =>
      Effect.gen(function* () {
        const job = {
          name: `dedup-${label}`,
          payload: {},
          idempotencyKey: "blocked-key",
        };
        const url = new URL(scratchUrl);
        if (urlTimeouts) {
          for (const parameter of [
            "query_timeout",
            "statement_timeout",
            "lock_timeout",
            "idle_in_transaction_session_timeout",
          ]) {
            url.searchParams.set(parameter, "60000");
          }
          url.searchParams.set("options", "-c statement_timeout=60000 -c lock_timeout=60000");
        }
        const runner = makeJobs(url.toString());
        yield* Effect.gen(function* () {
          yield* enqueueWith(runner, { ...job, idempotencyKey: "warm-queue" });
          const exit = yield* withScratch(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  // This is the lock protocol all upgraded producers share. The readiness check below
                  // proves the real production query is waiting on it before interruption is requested.
                  yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(
              ${JSON.stringify(["mend-live-job-v1", "pgboss", job.name, job.idempotencyKey])}, 0))`;
                  const abort = new AbortController();
                  const pending = runner.runPromiseExit(
                    Effect.flatMap(JobRunner, (service) => service.enqueue(job)),
                    { signal: abort.signal },
                  );
                  yield* until(
                    withAdmin(
                      Effect.gen(function* () {
                        const observer = yield* SqlClient.SqlClient;
                        return yield* observer<{ count: number }>`
                      SELECT count(*)::int AS count FROM pg_stat_activity
                      WHERE datname = ${SCRATCH_DB} AND application_name = 'mend-jobs-enqueue'
                        AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
                      }),
                    ).pipe(Effect.map((waiting) => (waiting[0]?.count ?? 0) > 0)),
                    "the production enqueue to wait on its key",
                  );
                  // Another instance can enqueue a different key of this very queue while this one waits.
                  expect(
                    yield* enqueue({ ...job, idempotencyKey: "different-key" }, true),
                  ).not.toBeNull();
                  if (interrupted) abort.abort();
                  return yield* Effect.promise(() => pending);
                }),
              );
            }),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            if (interrupted) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            else expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "JobEnqueueError" });
          }
          expect(
            yield* boss((client) => client.findJobs(job.name, { key: job.idempotencyKey })),
          ).toEqual([]);
          const transactions = yield* withAdmin(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = ${SCRATCH_DB} AND application_name = 'mend-jobs-enqueue'
            AND state = 'idle in transaction'`;
            }),
          );
          expect(transactions[0]?.count).toBe(0);
          expect(yield* enqueueWith(runner, job)).not.toBeNull();
          expect(yield* enqueue(job, true)).toBeNull();
        }).pipe(Effect.ensuring(runner.disposeEffect));
      }),
    15_000,
  );

  it.live.each([
    { isolation: "read committed", name: "dedup-concurrent" },
    { isolation: "repeatable read", name: "dedup-snapshot" },
  ])(
    "accepts exactly one concurrent same-key enqueue across runners with $isolation defaults",
    ({ isolation, name }) =>
      Effect.gen(function* () {
        yield* withAdmin(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(
              `ALTER DATABASE ${SCRATCH_DB} SET default_transaction_isolation TO '${isolation}'`,
            );
          }),
        );
        const first = makeJobs();
        const second = makeJobs();
        // Each probe starts as soon as it is created, as an independent producer would.
        const enqueueProbe = (key: string, sender: number) =>
          (sender % 2 === 0 ? first : second).runPromise(
            Effect.flatMap(JobRunner, (service) =>
              service.enqueue({ name, payload: { sender }, idempotencyKey: key }),
            ),
          );
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => first.runPromise(Effect.void));
          yield* Effect.promise(() => second.runPromise(Effect.void));
          yield* Effect.promise(() => enqueueProbe("warm-first", -2));
          yield* Effect.promise(() => enqueueProbe("warm-second", -1));
          // Hold inserts while producers reach the database. The old lookup/send race leaves multiple
          // inserts waiting; the atomic implementation leaves one insert and a same-key lock waiter.
          const pending = yield* withScratch(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`LOCK TABLE pgboss.job IN SHARE MODE`;
                  const attempts = Array.from({ length: 30 }, (_, sender) =>
                    enqueueProbe("same-key", sender),
                  );
                  yield* until(
                    withAdmin(
                      Effect.gen(function* () {
                        const observer = yield* SqlClient.SqlClient;
                        return yield* observer<{ count: number }>`
                      SELECT count(*)::int AS count FROM pg_stat_activity
                      WHERE datname = ${SCRATCH_DB} AND wait_event_type = 'Lock'
                        AND (application_name = 'mend-jobs-enqueue'
                          OR (application_name = 'mend-jobs'
                            AND query LIKE ${`%${name}%`}))`;
                      }),
                    ).pipe(Effect.map((blocked) => (blocked[0]?.count ?? 0) >= 2)),
                    "independent producers blocked at the database",
                  );
                  return attempts;
                }),
              );
            }),
          );
          const replies = yield* Effect.promise(() => Promise.all(pending));
          const rows = yield* withScratch(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{ id: string; data: { sender: number }; state: string }>`
          SELECT id, data, state FROM pgboss.job
          WHERE name = ${name} AND singleton_key = 'same-key'
            AND state IN ('created', 'retry', 'active')`;
            }),
          );
          expect({
            accepted: replies.filter((id) => id !== null).length,
            liveRows: rows.length,
          }).toEqual({
            accepted: 1,
            liveRows: 1,
          });
          expect(rows[0]?.id).toBe(replies.find((id) => id !== null));
          expect(rows[0]?.data.sender).toBe(replies.findIndex((id) => id !== null));
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* first.disposeEffect;
              yield* second.disposeEffect;
              yield* withAdmin(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql.unsafe(
                    `ALTER DATABASE ${SCRATCH_DB} RESET default_transaction_isolation`,
                  );
                }),
              ).pipe(Effect.orDie);
            }),
          ),
        );
      }),
    30_000,
  );

  it.live(
    "drops an enqueue while the key's job is live, and takes it again once that job is done",
    () =>
      Effect.gen(function* () {
        const enqueueKey = (key: string) =>
          enqueueWith(jobs(), { name: "dedup-probe", payload: {}, idempotencyKey: key });
        const first = yield* enqueueKey("dedup-probe:change-1");
        expect(first).not.toBeNull();
        // Queued, not yet worked: the same key is dropped; another key is not.
        expect(yield* enqueueKey("dedup-probe:change-1")).toBeNull();
        expect(yield* enqueueKey("dedup-probe:change-2")).not.toBeNull();

        const ran: Array<unknown> = [];
        yield* Effect.promise(() =>
          jobs().runPromise(
            Effect.gen(function* () {
              const runner = yield* JobRunner;
              yield* runner.work("dedup-probe", (payload) =>
                Effect.sync(() => void ran.push(payload)),
              );
            }),
          ),
        );
        yield* until(
          Effect.sync(() => ran.length === 2),
          "both jobs to run",
        );
        // Completed frees the key.
        yield* until(
          enqueueKey("dedup-probe:change-1").pipe(Effect.map((id) => id !== null)),
          "the key to be free",
        );
      }),
    30_000,
  );

  it.live(
    "runs jobs of one name side by side when the worker asks for it",
    () =>
      Effect.gen(function* () {
        let running = 0;
        let overlapped = 0;
        let done = 0;
        const bothStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.promise(() =>
          jobs().runPromise(
            Effect.gen(function* () {
              const runner = yield* JobRunner;
              yield* runner.enqueue({
                name: "concurrency-probe",
                payload: {},
                idempotencyKey: "a",
              });
              yield* runner.enqueue({
                name: "concurrency-probe",
                payload: {},
                idempotencyKey: "b",
              });
              yield* runner.work(
                "concurrency-probe",
                () =>
                  Effect.gen(function* () {
                    running += 1;
                    overlapped = Math.max(overlapped, running);
                    if (running === 2) yield* Deferred.succeed(bothStarted, undefined);
                    yield* Deferred.await(release);
                    running -= 1;
                    done += 1;
                  }),
                { localConcurrency: 2 },
              );
            }),
          ),
        );
        yield* Deferred.await(bothStarted).pipe(
          Effect.timeout("5 seconds"),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
        yield* until(
          Effect.sync(() => done === 2),
          "both jobs to finish",
        );
        expect(overlapped).toBe(2);
      }),
    30_000,
  );
});
