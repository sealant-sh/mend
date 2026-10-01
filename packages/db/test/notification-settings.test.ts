import { PgClient } from "@effect/sql-pg";
import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  NotificationSettingsRepo,
  NotificationSettingsRepoLive,
} from "../src/repos/notification-settings.ts";

/**
 * What each person hears about on their phones, against the dev Postgres (`compose.dev.yaml`,
 * :5434) in a throwaway database. Without one reachable these skip rather than pretend; set
 * MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_notification_settings_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = NotificationSettingsRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, NotificationSettingsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

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

describe.skipIf(!reachable)("notification settings, in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES
            ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z'),
            ('ben', 'Ben Example', 'ben@example.com', '2026-01-01T00:00:00Z')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("answers the defaults until the account saves its own, and keeps each account's apart", async () => {
    await run(
      Effect.gen(function* () {
        const settings = yield* NotificationSettingsRepo;
        expect(yield* settings.forUser("anna")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
        expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
          slackSessions: false,
          turnFinished: true,
          needsInput: true,
          failed: true,
        });

        const quiet = new NotificationSettings({
          slackSessions: true,
          turnFinished: false,
          needsInput: true,
          failed: false,
        });
        expect(yield* settings.set("anna", quiet)).toEqual(quiet);
        expect(yield* settings.forUser("anna")).toEqual(quiet);
        const louder = new NotificationSettings({ ...quiet, turnFinished: true });
        yield* settings.set("anna", louder);

        const both = yield* settings.forUsers(["anna", "ben"]);
        expect(both.get("anna")).toEqual(louder);
        expect(both.get("ben")).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
        expect((yield* settings.forUsers([])).size).toBe(0);
      }),
    );
  });

  it("goes with the account", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* NotificationSettingsRepo;
        yield* settings.set("ben", DEFAULT_NOTIFICATION_SETTINGS);
        yield* sql`DELETE FROM "user" WHERE id = 'ben'`;
        const rows =
          yield* sql`SELECT user_id FROM user_notification_settings WHERE user_id = 'ben'`;
        expect(rows).toEqual([]);
      }),
    );
  });
});
