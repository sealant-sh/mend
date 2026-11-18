import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { postgresTestConfig } from "./postgres.ts";

/**
 * 0229 turns every person's Inherit into the value it resolved to, so nobody's sessions change on
 * upgrade. Each case seeds a server as it stood before, in its own throwaway database.
 */
const config = postgresTestConfig();
const MIGRATION = "0229_person_automation_own";
const made: Array<string> = [];

const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(config.adminUrl) })),
      Effect.scoped,
    ),
  );

type Switches = {
  readonly auto_tour: boolean;
  readonly auto_suggest: boolean;
  readonly auto_name: boolean;
  readonly auto_land: boolean;
  readonly background_sessions: boolean;
};

/** A database migrated to just before this migration, seeded by `seed`, then migrated by it. */
const upgraded = async (
  seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
): Promise<{
  readonly switches: (userId: string) => Promise<Switches>;
  readonly run: <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
}> => {
  const database = `mend_person_automation_${process.pid}_${Date.now()}_${made.length}`;
  made.push(database);
  await admin(`CREATE DATABASE ${database}`);
  const url = new URL(config.adminUrl);
  url.pathname = `/${database}`;
  const layer = PgClient.layer({ url: Redacted.make(url.toString()) });
  const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(work.pipe(Effect.provide(layer), Effect.scoped));
  await run(
    Effect.gen(function* () {
      const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
      for (const [name, migration] of ordered) if (name < MIGRATION) yield* migration;
      yield* seed;
      yield* migrations[MIGRATION];
    }),
  );
  return {
    run,
    switches: async (userId) => {
      const rows = await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<Switches>`SELECT auto_tour, auto_suggest, auto_name, auto_land,
            background_sessions FROM user_automation_settings WHERE user_id = ${userId}`,
        ),
      );
      const [row] = rows;
      if (row === undefined) throw new Error(`no row for ${userId}`);
      return { ...row };
    },
  };
};

const people = (...ids: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(
      ids,
      (id) => sql`INSERT INTO "user" (id, name, email) VALUES (${id}, ${id}, ${`${id}@acme.dev`})`,
      { discard: true },
    ),
  );

const member = (organizationId: string, userId: string, chosenAt: string | null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO organization_members (organization_id, user_id, role, last_chosen_at)
      VALUES (${organizationId}, ${userId}, 'member', ${chosenAt}::timestamptz)`,
  );

afterAll(async () => {
  for (const database of made) await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}, 60_000);

describe.skipIf(config.skip)("0229: a person's automation becomes their own", () => {
  it("keeps what each person's switches resolved to: their own, else the organization's, else the instance's", async () => {
    const server = await upgraded(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The instance's document turns the tour off and landing on, and predates the
        // background switch, which it reads as Mend's default (on).
        yield* sql`INSERT INTO settings (key, value) VALUES ('mend', ${JSON.stringify({
          prMode: "draft-immediately",
          concurrency: 1,
          autoTour: false,
          autoSuggest: true,
          autoName: true,
          autoLand: true,
        })}::jsonb)`;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme'), ('beta', 'Beta')`;
        // Acme turns suggestions off and background sessions off; Beta set nothing of its own.
        yield* sql`INSERT INTO organization_settings (organization_id, auto_suggest,
          background_sessions) VALUES ('acme', false, false)`;
        yield* people("ada", "ben", "cleo", "dev", "eve");
        // Ada is in Acme and never saved: Acme's, else the instance's.
        yield* member("acme", "ada", null);
        // Ben is in Acme and saved landing off and the tour on; the rest he inherited.
        yield* member("acme", "ben", null);
        yield* sql`INSERT INTO user_automation_settings (user_id, auto_tour, auto_land)
          VALUES ('ben', true, false)`;
        // Cleo is in Beta, which follows the instance.
        yield* member("beta", "cleo", null);
        // Dev is in both and last chose Beta: they resolve through Beta, as /me/automation showed.
        yield* member("acme", "dev", "2026-11-01T00:00:00Z");
        yield* member("beta", "dev", "2026-11-10T00:00:00Z");
        // Eve is in no organization: the instance's.
      }),
    );
    const instance = {
      auto_tour: false,
      auto_suggest: true,
      auto_name: true,
      auto_land: true,
      background_sessions: true,
    };
    const acme = { ...instance, auto_suggest: false, background_sessions: false };
    expect(await server.switches("ada")).toEqual(acme);
    expect(await server.switches("ben")).toEqual({ ...acme, auto_tour: true, auto_land: false });
    expect(await server.switches("cleo")).toEqual(instance);
    expect(await server.switches("dev")).toEqual(instance);
    expect(await server.switches("eve")).toEqual(instance);
  }, 120_000);

  it("falls back to Mend's built-in defaults on a server whose operator saved no settings, and stores no Inherit after", async () => {
    const server = await upgraded(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('acme', 'Acme')`;
        yield* sql`INSERT INTO organization_settings (organization_id, auto_land)
          VALUES ('acme', true)`;
        yield* people("ada", "ben");
        yield* member("acme", "ada", null);
      }),
    );
    const builtIn = {
      auto_tour: true,
      auto_suggest: true,
      auto_name: true,
      auto_land: false,
      background_sessions: true,
    };
    expect(await server.switches("ada")).toEqual({ ...builtIn, auto_land: true });
    expect(await server.switches("ben")).toEqual(builtIn);
    // An account made after the upgrade starts on Mend's defaults, and Inherit cannot be stored.
    await server.run(people("finn"));
    await server.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`INSERT INTO user_automation_settings (user_id) VALUES ('finn')`,
      ),
    );
    expect(await server.switches("finn")).toEqual(builtIn);
    await expect(
      server.run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`UPDATE user_automation_settings SET auto_land = NULL WHERE user_id = 'ada'`,
        ),
      ),
    ).rejects.toThrow();
  }, 120_000);
});
