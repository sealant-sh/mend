import { PgClient } from "@effect/sql-pg";
import {
  ResourceDefinition,
  presetDefinition,
  PresetVersion,
  ResourceName,
  resourceSpecDigest,
} from "@mend/domain/workbench";
import { Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { postgresTestConfig } from "./postgres.ts";
const config = postgresTestConfig();
const database = `mend_resource_levels_${process.pid}_${Date.now()}`;
const url = new URL(config.adminUrl);
url.pathname = `/${database}`;
const layer = PgClient.layer({ url: Redacted.make(url.toString()) });
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(work.pipe(Effect.provide(layer), Effect.scoped));
const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(config.adminUrl) })),
      Effect.scoped,
    ),
  );
const pg = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
});
const cache = presetDefinition({
  name: ResourceName.make("cache"),
  preset: "redis",
  version: PresetVersion.make("8"),
});
describe.skipIf(config.skip)("0177 resource levels migration", () => {
  beforeAll(async () => {
    await admin(`CREATE DATABASE ${database}`);
    await run(
      Effect.gen(function* () {
        for (const [name, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          if (name < "0177_resource_levels") yield* migration;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations(id,name) VALUES ('org','Migration')`;
        yield* sql`INSERT INTO projects(id,name,store_path,default_branch,organization_id) VALUES ('p','p','/store/p','main','org')`;
        for (const id of ["after", "before", "unused"])
          yield* sql`INSERT INTO worktrees(id,project_id,name,directory,branch,base_sha) VALUES (${id},'p',${id},${id},${id},'abc')`;
        for (const [id, at] of [
          ["after", "2026-10-31T12:00:00Z"],
          ["before", "2026-10-29T12:00:00Z"],
        ])
          yield* sql`INSERT INTO agent_sessions(id,project_id,worktree_id,harness,worktree,branch,base_sha,created_at) VALUES (${id},'p',${id},'claude',${id},${id},'abc',${at}::timestamptz)`;
        for (const [spec, scope] of [
          [pg, "project"],
          [cache, "worktree"],
        ] as const) {
          const json = JSON.stringify({ ...Schema.encodeSync(ResourceDefinition)(spec), scope });
          yield* sql`INSERT INTO resource_definitions(id,project_id,name,scope,preset,spec,spec_digest,image_digest,added_by,created_at) VALUES (${spec.name},'p',${spec.name},${scope},${spec.preset},${json}::jsonb,${"a".repeat(64)},${`sha256:${"b".repeat(64)}`},'alice','2026-10-30T12:00:00Z')`;
        }
        yield* sql`INSERT INTO resource_selections(worktree_id,definition_id,mode,chosen_by) VALUES ('before','db','own','alice'),('after','db','shared','alice')`;
        yield* sql`INSERT INTO resource_own_databases(worktree_id,definition_id,origin) VALUES ('before','db','copied')`;
        yield* migrations["0177_resource_levels"];
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  }, 60_000);
  it("preserves identities and pins, migrates only eligible worktrees, and hashes the scope-free spec", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          resource_id: string;
          worktree_id: string | null;
          spec: unknown;
          spec_digest: string;
          image_digest: string;
          started_by: string;
          started_at: Date;
        }>`SELECT * FROM resource_instances ORDER BY resource_id`;
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => [row.resource_id, row.worktree_id])).toEqual([
          ["cache", "after"],
          ["db", null],
        ]);
        for (const row of rows) {
          const spec = Schema.decodeUnknownSync(ResourceDefinition)(row.spec);
          expect(row.spec).not.toHaveProperty("scope");
          expect(row.spec_digest).toBe(resourceSpecDigest(spec));
          expect(row.image_digest).toBe(`sha256:${"b".repeat(64)}`);
          expect(row.started_by).toBe("alice");
          expect(row.started_at.toISOString()).toBe("2026-10-30T12:00:00.000Z");
        }
        expect(yield* sql`SELECT id,name FROM resource_definitions ORDER BY id`).toEqual([
          { id: "cache", name: "cache" },
          { id: "db", name: "db" },
        ]);
        expect(
          yield* sql`SELECT worktree_id,definition_id,mode FROM resource_selections ORDER BY definition_id,worktree_id`,
        ).toEqual([
          { worktree_id: "after", definition_id: "cache", mode: "worktree" },
          { worktree_id: "after", definition_id: "db", mode: "project" },
          { worktree_id: "before", definition_id: "db", mode: "worktree" },
        ]);
        expect(
          yield* sql`SELECT worktree_id,definition_id,origin FROM resource_own_databases`,
        ).toEqual([{ worktree_id: "before", definition_id: "db", origin: "copied" }]);
        expect(yield* sql`SELECT DISTINCT uses_project_resources FROM worktrees`).toEqual([
          { uses_project_resources: true },
        ]);
      }),
    );
  });
});
