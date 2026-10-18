import { PgClient } from "@effect/sql-pg";
import { Effect, Exit, Fiber, Queue, Redacted, type Scope, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listenEvents, MEND_EVENTS_CHANNEL, notifyEvent } from "../src/events.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
// NOTIFY reaches only listeners of the same database, so a throwaway one isolates this file.
const SCRATCH_DB = `mend_events_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(scratchLayer)));

let scratchCreated = false;

const MARKER = { type: "organization", organizationId: "listen-ready" } as const;

const listening = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const received = yield* Queue.unbounded<string>();
  const listener = yield* listenEvents(sql).pipe(
    Stream.runForEach((payload) => Queue.offer(received, payload)),
    Effect.forkScoped,
  );
  const marker = JSON.stringify(MARKER);
  yield* notifyEvent(sql, MARKER).pipe(
    Effect.andThen(Effect.sleep("20 millis")),
    Effect.repeat({ until: () => Queue.sizeUnsafe(received) > 0 }),
  );
  for (;;) {
    const payload = yield* Queue.take(received);
    if (payload !== marker) return yield* Effect.die(`unexpected payload ${payload}`);
    if (Queue.sizeUnsafe(received) === 0) break;
  }
  return { sql, received, listener };
});

describe.skipIf(postgres.skip)("mend_events in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
        scratchCreated = true;
      }),
    );
  });

  afterAll(async () => {
    if (!scratchCreated) return;
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("delivers each notified payload once, in order", () =>
    run(
      Effect.gen(function* () {
        const { sql, received } = yield* listening;
        yield* notifyEvent(sql, { type: "session", sessionId: "s1", projectId: "p1" });
        yield* notifyEvent(sql, { type: "organization", organizationId: "o1" });
        const first = yield* Queue.take(received);
        const second = yield* Queue.take(received);
        expect([JSON.parse(first), JSON.parse(second)]).toEqual([
          { type: "session", sessionId: "s1", projectId: "p1" },
          { type: "organization", organizationId: "o1" },
        ]);
      }),
    ));

  it("fails the stream when its connection is lost, so consumers can listen again", () =>
    run(
      Effect.gen(function* () {
        const { sql, listener } = yield* listening;
        const terminated = yield* sql<{ readonly terminated: boolean }>`
          SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND query ILIKE ${`LISTEN %${MEND_EVENTS_CHANNEL}%`}`;
        expect(terminated).toEqual([{ terminated: true }]);
        const exit = yield* Fiber.await(listener).pipe(Effect.timeout("5 seconds"));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ));
});
