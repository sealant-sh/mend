import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { preview105ExecutorMigrations } from "./fixtures/executor-preview105.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_executor_migrations_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratch = PgClient.layer({ url: Redacted.make(scratchUrl.toString()) });
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(scratch), Effect.scoped));
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));

const entries = Object.entries(migrations);
const executorNames = new Set([
  "executor_links",
  "executor_instances",
  "executor_identity",
  "executor_service_connections",
]);
const isExecutorMigration = (name: string) => executorNames.has(name.slice(name.indexOf("_") + 1));
const executorEntries = entries.filter(([name]) => isExecutorMigration(name));
const mainMigrations = Object.fromEntries(entries.filter(([name]) => !isExecutorMigration(name)));
// Production IDs are allocated above main and every deployed preview at merge time.
// These two synthetic blocks prove repeated allocation without reserving real IDs.
const allocated = (first: number) =>
  Object.fromEntries(
    executorEntries.map(([name, effect], offset) => [
      `${first + offset}_${name.slice(name.indexOf("_") + 1)}`,
      effect,
    ]),
  );
const migrate = (record: typeof mainMigrations) =>
  Migrator.make({})({ loader: Migrator.fromRecord(record), table: "mend_migrations" });

const empty = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP SCHEMA IF EXISTS executor_identity CASCADE`;
  yield* sql`DROP SCHEMA public CASCADE`;
  yield* sql`CREATE SCHEMA public`;
});

const inventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql`SELECT table_schema, table_name, column_name,
      ordinal_position, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'executor_identity' OR
      (table_schema = 'public' AND (table_name LIKE 'executor_%' OR table_name = 'organization_executors'))
    ORDER BY table_schema, table_name, ordinal_position`;
  const constraints = yield* sql`SELECT n.nspname, c.relname, con.conname,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'executor_identity' OR
      (n.nspname = 'public' AND (c.relname LIKE 'executor_%' OR c.relname = 'organization_executors'))
    ORDER BY n.nspname, c.relname, con.conname`;
  const indexes = yield* sql`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'executor_identity' OR
      (schemaname = 'public' AND (tablename LIKE 'executor_%' OR tablename = 'organization_executors'))
    ORDER BY schemaname, tablename, indexname`;
  const tables = yield* sql<{ schemaname: string; tablename: string }>`
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'executor_identity' OR
      (schemaname = 'public' AND (tablename LIKE 'executor_%' OR tablename = 'organization_executors'))
    ORDER BY schemaname, tablename`;
  const data = yield* Effect.forEach(tables, (table) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT to_jsonb(t) AS row
        FROM ${sql(table.schemaname)}.${sql(table.tablename)} t ORDER BY to_jsonb(t)::text`;
      return { table: `${table.schemaname}.${table.tablename}`, rows };
    }),
  );
  return { schema: { columns, constraints, indexes }, data };
});

const seedLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO organizations(id, name) VALUES ('ex-org', 'Executor migration')`;
  yield* sql`INSERT INTO "user"(id, name, email, "createdAt")
    VALUES ('ex-person', 'Person', 'person@example.invalid', '2026-01-01T00:00:00Z')`;
  yield* sql`INSERT INTO projects(id, name, organization_id, store_path, default_branch)
    VALUES ('ex-project', 'Executor migration', 'ex-org', '/fixture/repo.git', 'main')`;
  yield* sql`INSERT INTO worktrees(id, project_id, name, directory, branch, base_sha)
    VALUES ('ex-worktree', 'ex-project', 'fixture', '/fixture/worktree', 'fixture', 'abc')`;
  yield* sql`INSERT INTO agent_sessions(id, project_id, worktree_id, harness, worktree, branch, base_sha)
    VALUES ('ex-session', 'ex-project', 'ex-worktree', 'codex', '/fixture/worktree', 'fixture', 'abc')`;
  yield* sql`INSERT INTO organization_executors(organization_id, id, mode, url)
    VALUES ('ex-org', 'ex-config', 'mend-run', 'http://executor.localhost:4400')`;
  yield* sql`INSERT INTO executor_links(id, configuration_id, subject, user_id, state, sealed_credentials)
    VALUES ('ex-link', 'ex-config', 'person', 'ex-person', 'active', 'fixture-sealed-grants')`;
  yield* sql`INSERT INTO executor_link_flows(state_hash, configuration_id, actor_id, subject, sealed_flow, expires_at)
    VALUES ('fixture-state', 'ex-config', 'ex-person', 'person', 'fixture-sealed-flow', '2099-01-01')`;
  yield* sql`INSERT INTO executor_calls(id, session_id, link_id, as_user_id, as_member, service, tool, outcome, message, sealed_result)
    VALUES ('ex-call', 'ex-session', 'ex-link', 'ex-person', false, 'fixture', 'read', 'completed', 'Observed', 'fixture-sealed-result')`;
  yield* sql`INSERT INTO executor_instances(organization_id, scope_key, sealed_state, applied_spec, image, backup_at, executor_organization_id)
    VALUES ('ex-org', 'fixture-scope', 'fixture-sealed-instance', 'fixture-spec', 'fixture-image', '2026-01-01', 'fixture-executor-org')`;
});

const seedPrivate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO executor_identity.authority(sealed_state) VALUES ('fixture-sealed-ca')`;
  yield* sql`INSERT INTO executor_identity."user"(id, name, email, "emailVerified")
    VALUES ('ex-identity', 'Person', 'ex-person@ex-org.people.mend.invalid', true)`;
  yield* sql`INSERT INTO executor_identity."session"(id, "expiresAt", token, "updatedAt", "userId")
    VALUES ('ex-identity-session', '2099-01-01', 'fixture-session', '2026-01-01', 'ex-identity')`;
  yield* sql`INSERT INTO executor_identity.link_tickets(digest, organization_id, user_id, authorize_url, expires_at)
    VALUES ('fixture-ticket', 'ex-org', 'ex-person', 'https://fixture.invalid/authorize', '2099-01-01')`;
  yield* sql`INSERT INTO executor_service_connections(id, configuration_id, link_id, actor_id, connection_id, method, target, state_hash, expires_at)
    VALUES ('ex-connection', 'ex-config', 'ex-link', 'ex-person', 'fixture-connection', 'oauth', 'person', 'fixture-connection-state', '2099-01-01')`;
});

describe.skipIf(postgres.skip)(
  "Executor migrations across provisional and final allocations",
  () => {
    beforeAll(() =>
      withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`CREATE DATABASE ${database}`);
        }),
      ),
    );
    afterAll(() =>
      withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`DROP DATABASE IF EXISTS ${database}`);
        }),
      ),
    );
    beforeEach(() => run(empty));

    it("applies the entire registry to an empty database in ascending order", () =>
      run(
        Effect.gen(function* () {
          expect(entries.map(([name]) => name)).toEqual(entries.map(([name]) => name).toSorted());
          const applied = yield* migrate(migrations);
          expect(applied.map(([id]) => id)).toEqual(
            entries.map(([name]) => Number(name.slice(0, name.indexOf("_")))),
          );
          expect(yield* migrate(migrations)).toEqual([]);
          yield* seedLinks;
          yield* seedPrivate;
        }),
      ));

    it("upgrades main at 0194 using a block allocated above its latest ID", () =>
      run(
        Effect.gen(function* () {
          yield* migrate(migrations);
          const expected = (yield* inventory).schema;
          yield* empty;
          yield* migrate(mainMigrations);
          const applied = yield* migrate({ ...mainMigrations, ...allocated(10_000) });
          expect(applied.map(([id]) => id)).toEqual([10_000, 10_001, 10_002, 10_003]);
          expect((yield* inventory).schema).toEqual(expected);
          yield* seedLinks;
          yield* seedPrivate;
        }),
      ));

    it("converges preview 105's exact 0192/0193 SQL plus main's 0194 without changing saved rows", () =>
      run(
        Effect.gen(function* () {
          yield* migrate(migrations);
          const expected = (yield* inventory).schema;
          yield* empty;
          const beforeForks = Object.fromEntries(
            Object.entries(mainMigrations).filter(([name]) => name < "0194"),
          );
          yield* migrate({ ...beforeForks, ...preview105ExecutorMigrations });
          yield* seedLinks;
          const before = (yield* inventory).data;
          yield* migrate(mainMigrations);
          yield* migrate({ ...mainMigrations, ...allocated(10_000) });
          const after = yield* inventory;
          expect(after.schema).toEqual(expected);
          for (const saved of before)
            expect(after.data.find((table) => table.table === saved.table)).toEqual(saved);
          yield* seedPrivate;
        }),
      ));

    it("reapplies all four migrations under two fresh ID blocks without changing schema or data", () =>
      run(
        Effect.gen(function* () {
          yield* migrate(migrations);
          yield* seedLinks;
          yield* seedPrivate;
          const before = yield* inventory;
          for (const first of [10_000, 20_000]) {
            const record = { ...mainMigrations, ...allocated(first) };
            expect(yield* migrate(record)).toHaveLength(4);
            expect(yield* inventory).toEqual(before);
            expect(yield* migrate(record)).toEqual([]);
          }
        }),
      ));
  },
);
