import { PgClient } from "@effect/sql-pg";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Schedule,
  type Scope,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDB, MendDBLive } from "../src/client.ts";
import { listenEvents, MEND_EVENTS_CHANNEL, type MendEvent, notifyEvent } from "../src/events.ts";
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

// MEND_DATABASE_POOL_MAX's default (src/client.ts), and the LISTEN connections one server pins on
// it: the event bus, automatic landing, review prep, the session notifier and the Slack reporter.
const PRODUCTION_POOL_MAX = 6;
const SERVER_LISTENERS = 5;
const productionSizedLayer = MendDBLive.pipe(
  Layer.provideMerge(
    PgClient.layer({ url: Redacted.make(scratchUrl), maxConnections: PRODUCTION_POOL_MAX }),
  ),
);

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

  it("commits a transaction that publishes while every other pooled connection is pinned", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sql, received } = yield* listening;
        for (let pinned = 1; pinned < SERVER_LISTENERS; pinned++) {
          yield* Effect.forkScoped(Stream.runDrain(listenEvents(sql)));
        }
        yield* sql<{ readonly listeners: number }>`
          SELECT count(*)::int AS listeners FROM pg_stat_activity
           WHERE datname = current_database()
             AND query ILIKE ${`LISTEN %${MEND_EVENTS_CHANNEL}%`}`.pipe(
          Effect.repeat({
            until: ([row]) => row?.listeners === SERVER_LISTENERS,
            schedule: Schedule.spaced("20 millis"),
          }),
        );
        const db = yield* MendDB;
        const event: MendEvent = { type: "session", sessionId: "pinned", projectId: "p1" };
        yield* db
          .transaction(() => notifyEvent(sql, event))
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);
        expect(JSON.parse(yield* Queue.take(received))).toEqual(event);
      }).pipe(Effect.scoped, Effect.provide(productionSizedLayer)),
    ));

  it("delivers a notify published inside a transaction when it commits, not before", () =>
    run(
      Effect.gen(function* () {
        const { sql, received } = yield* listening;
        const inside: MendEvent = { type: "session", sessionId: "inside", projectId: "p1" };
        const outside: MendEvent = { type: "session", sessionId: "outside", projectId: "p1" };
        const sendOutside = yield* Deferred.make<void>();
        const sentOutside = yield* Deferred.make<void>();
        yield* Deferred.await(sendOutside).pipe(
          Effect.andThen(notifyEvent(sql, outside)),
          Effect.andThen(Deferred.succeed(sentOutside, undefined)),
          Effect.forkScoped,
        );
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* notifyEvent(sql, inside);
            yield* Deferred.succeed(sendOutside, undefined);
            yield* Deferred.await(sentOutside);
          }),
        );
        const first = yield* Queue.take(received);
        const second = yield* Queue.take(received);
        expect([JSON.parse(first), JSON.parse(second)]).toEqual([outside, inside]);
      }),
    ));

  it("sends nothing for a transaction that rolls back", () =>
    run(
      Effect.gen(function* () {
        const { sql, received } = yield* listening;
        const rolledBack: MendEvent = {
          type: "session",
          sessionId: "rolled-back",
          projectId: "p1",
        };
        const after: MendEvent = { type: "session", sessionId: "after", projectId: "p1" };
        const exit = yield* sql
          .withTransaction(notifyEvent(sql, rolledBack).pipe(Effect.andThen(Effect.fail("abort"))))
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* notifyEvent(sql, after);
        expect(JSON.parse(yield* Queue.take(received))).toEqual(after);
        expect(Queue.sizeUnsafe(received)).toBe(0);
      }),
    ));
});
