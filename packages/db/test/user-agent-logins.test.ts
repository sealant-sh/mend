import { PgClient } from "@effect/sql-pg";
import { AgentLogins, DEFAULT_AGENT_LOGINS } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { UserAgentLoginsRepo, UserAgentLoginsRepoLive } from "../src/repos/user-agent-logins.ts";

/**
 * Which of a person's own logins their Claude and Codex sessions receive, against the dev Postgres (`compose.dev.yaml`,
 * :5434) in a throwaway database. Without one reachable these skip rather than pretend; set
 * MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_user_agent_logins_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = UserAgentLoginsRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, UserAgentLoginsRepo | SqlClient.SqlClient>) =>
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

describe.skipIf(!reachable)("agent logins per person, in Postgres", () => {
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

  it("answers every login until the account saves its own, and keeps each account's apart", async () => {
    await run(
      Effect.gen(function* () {
        const logins = yield* UserAgentLoginsRepo;
        expect(yield* logins.forUser("anna")).toEqual(DEFAULT_AGENT_LOGINS);
        expect(DEFAULT_AGENT_LOGINS).toEqual({ selectedOnly: false });

        const selected = new AgentLogins({ selectedOnly: true });
        expect(yield* logins.set("anna", selected)).toEqual(selected);
        expect(yield* logins.forUser("anna")).toEqual(selected);
        expect(yield* logins.forUser("ben")).toEqual(DEFAULT_AGENT_LOGINS);
        expect(yield* logins.set("anna", DEFAULT_AGENT_LOGINS)).toEqual(DEFAULT_AGENT_LOGINS);
        expect(yield* logins.forUser("anna")).toEqual(DEFAULT_AGENT_LOGINS);
      }),
    );
  });

  it("goes with the account", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const logins = yield* UserAgentLoginsRepo;
        yield* logins.set("ben", new AgentLogins({ selectedOnly: true }));
        yield* sql`DELETE FROM "user" WHERE id = 'ben'`;
        const rows = yield* sql`SELECT user_id FROM user_agent_logins WHERE user_id = 'ben'`;
        expect(rows).toEqual([]);
      }),
    );
  });
});
