import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { JobRunner } from "../src/job-runner.ts";

/**
 * The live pg-boss layer against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway
 * database. Without one reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL
 * elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_jobs_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const until = async (check: () => Promise<boolean>, what: string) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(!reachable)("JobRunner on pg-boss", () => {
  let runtime: ManagedRuntime.ManagedRuntime<JobRunner, never> | null = null;
  const jobs = () => {
    if (runtime === null) throw new Error("runtime not started");
    return runtime;
  };

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    process.env["DATABASE_URL"] = scratchUrl;
    runtime = ManagedRuntime.make(JobRunner.pgBossLayer.pipe(Layer.orDie));
    await runtime.runPromise(Effect.void);
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    delete process.env["DATABASE_URL"];
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("drops an enqueue while the key's job is live, and takes it again once that job is done", async () => {
    const enqueue = (key: string) =>
      jobs().runPromise(
        Effect.gen(function* () {
          const runner = yield* JobRunner;
          return yield* runner.enqueue({ name: "dedup-probe", payload: {}, idempotencyKey: key });
        }),
      );
    const first = await enqueue("dedup-probe:change-1");
    expect(first).not.toBeNull();
    // Queued, not yet worked: the same key is dropped; another key is not.
    expect(await enqueue("dedup-probe:change-1")).toBeNull();
    expect(await enqueue("dedup-probe:change-2")).not.toBeNull();

    const ran: Array<unknown> = [];
    await jobs().runPromise(
      Effect.gen(function* () {
        const runner = yield* JobRunner;
        yield* runner.work("dedup-probe", (payload) => Effect.sync(() => void ran.push(payload)));
      }),
    );
    await until(async () => ran.length === 2, "both jobs to run");
    // Completed frees the key.
    await until(async () => (await enqueue("dedup-probe:change-1")) !== null, "the key to be free");
  }, 30_000);

  it("runs jobs of one name side by side when the worker asks for it", async () => {
    let running = 0;
    let overlapped = 0;
    let done = 0;
    await jobs().runPromise(
      Effect.gen(function* () {
        const runner = yield* JobRunner;
        yield* runner.work(
          "concurrency-probe",
          () =>
            Effect.gen(function* () {
              running += 1;
              overlapped = Math.max(overlapped, running);
              yield* Effect.sleep("1500 millis");
              running -= 1;
              done += 1;
            }),
          { localConcurrency: 2 },
        );
        yield* runner.enqueue({ name: "concurrency-probe", payload: {}, idempotencyKey: "a" });
        yield* runner.enqueue({ name: "concurrency-probe", payload: {}, idempotencyKey: "b" });
      }),
    );
    await until(async () => done === 2, "both jobs to finish");
    expect(overlapped).toBe(2);
  }, 30_000);
});
