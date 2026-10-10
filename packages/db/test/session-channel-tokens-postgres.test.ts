import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  SessionChannelTokensRepo,
  SessionChannelTokensRepoLive,
  WRITE_TOKEN_TTL_MS,
} from "../src/repos/session-channel-tokens.ts";

/**
 * A one-off write's token (a pasted image, mend#615 review 3), against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip rather
 * than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_channel_tokens_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = SessionChannelTokensRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SessionChannelTokensRepo | SqlClient.SqlClient>) =>
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

describe.skipIf(!reachable)("a one-off write's token, in Postgres (mend#615 review 3)", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is its person's, write-only; a bulk revocation of theirs never reaches it, its own revocation does", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SessionChannelTokensRepo;
        const own = yield* repo.issuePerson("launch-pg", "user-maria");
        const paste = yield* repo.issueWrite("launch-pg", "user-maria");
        const other = yield* repo.issueWrite("launch-pg", "user-maria");
        expect(yield* repo.resolve(paste)).toEqual({
          sessionId: "person-write:user-maria",
          launchId: "launch-pg",
          accountId: "user-maria",
          writeOnly: true,
        });
        expect((yield* repo.resolve(own))?.writeOnly).toBe(false);
        yield* repo.revokePerson("launch-pg", "user-maria", new Date(Date.now() + 60_000));
        expect(yield* repo.resolve(own)).toBeNull();
        expect((yield* repo.resolve(paste))?.writeOnly).toBe(true);
        yield* repo.revokeToken(paste);
        expect(yield* repo.resolve(paste)).toBeNull();
        expect((yield* repo.resolve(other))?.writeOnly).toBe(true);
        yield* repo.revokeLaunch("launch-pg");
        expect(yield* repo.resolve(other)).toBeNull();
      }),
    );
  });

  it("lapses once its time is up", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SessionChannelTokensRepo;
        const paste = yield* repo.issueWrite("launch-ttl", "user-maria");
        const own = yield* repo.issuePerson("launch-ttl", "user-maria");
        expect((yield* repo.resolve(paste))?.writeOnly).toBe(true);
        // Only the clock that reads the row moves: the row was issued now.
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + WRITE_TOKEN_TTL_MS + 1000 });
        expect(yield* repo.resolve(paste)).toBeNull();
        expect((yield* repo.resolve(own))?.accountId).toBe("user-maria");
      }),
    );
  });
});
