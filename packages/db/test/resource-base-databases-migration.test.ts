import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { postgresTestConfig } from "./postgres.ts";

const config = postgresTestConfig();
const database = `mend_resource_base_${process.pid}_${Date.now()}`;
const url = new URL(config.adminUrl);
url.pathname = `/${database}`;
const pg = PgClient.layer({ url: Redacted.make(url.toString()) });
const adminPg = PgClient.layer({ url: Redacted.make(config.adminUrl) });
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(pg), Effect.scoped));
const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(adminPg),
      Effect.scoped,
    ),
  );

describe.skipIf(config.skip)("0180 resource base databases migration", () => {
  beforeAll(async () => {
    await admin(`CREATE DATABASE ${database}`);
    await run(
      Effect.gen(function* () {
        for (const [name, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          if (name < "0180_resource_base_databases") yield* migration;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations(id,name) VALUES ('org','Migration')`;
        yield* sql`INSERT INTO projects(id,name,store_path,default_branch,organization_id) VALUES ('p','p','/store/p','main','org')`;
        yield* sql`INSERT INTO resource_definitions(id,project_id,name) VALUES ('db','p','db')`;
        yield* sql`INSERT INTO resource_own_databases(worktree_id,definition_id,origin,removal_dump_name,removal_dump_at,removal_checked_at)
        VALUES ('forgotten','db','copied','own-saved.dump',now(),now())`;
        yield* migrations["0180_resource_base_databases"];
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });
  it("preserves old own progress and allows a base row for the same worktree and definition", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO resource_own_databases(worktree_id,definition_id,origin,purpose)
        VALUES ('forgotten','db','empty','base')`;
        expect(
          yield* sql`SELECT purpose, origin, removal_dump_name,
        removal_checked_at IS NOT NULL AS checked FROM resource_own_databases ORDER BY purpose`,
        ).toEqual([
          { purpose: "base", origin: "empty", removal_dump_name: null, checked: false },
          { purpose: "own", origin: "copied", removal_dump_name: "own-saved.dump", checked: true },
        ]);
        const invalid =
          yield* sql`INSERT INTO resource_own_databases(worktree_id,definition_id,origin,purpose)
        VALUES ('bad','db','empty','other')`.pipe(Effect.result);
        expect(invalid._tag).toBe("Failure");
      }),
    );
  });
});
