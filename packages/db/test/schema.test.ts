import { PgClient } from "@effect/sql-pg";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgDialect, type PgColumn } from "drizzle-orm/pg-core";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import * as tables from "../src/schema/workbench.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_schema_parity_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(scratchLayer), Effect.scoped));
const dialect = new PgDialect();
const quote = (name: string) => dialect.escapeName(name);
const configs = Object.values(tables).map(getTableConfig);
let created = false;

const expression = (value: SQL) => {
  const query = dialect.sqlToQuery(value);
  if (query.params.length > 0) throw new Error("Schema DDL must not contain query parameters");
  return query.sql;
};
const defaultClause = (column: PgColumn) => {
  const value = column.default;
  if (value === undefined) return "";
  if (is(value, SQL)) return ` DEFAULT ${expression(value)}`;
  if (typeof value === "string") return ` DEFAULT ${dialect.escapeString(value)}`;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean")
    return ` DEFAULT ${String(value)}`;
  if (column.getSQLType() === "jsonb")
    return ` DEFAULT ${dialect.escapeString(JSON.stringify(value))}`;
  throw new Error(`Unsupported schema default for ${column.name}`);
};

// PostgreSQL canonicalizes the independently declared Drizzle model and migration DDL.
// This avoids treating equivalent types/default expressions as textual differences.
const modelDdl = () => {
  const statements = ["CREATE SCHEMA parity_model"];
  for (const config of configs) {
    if (
      config.schema !== undefined ||
      config.checks.length > 0 ||
      config.policies.length > 0 ||
      config.enableRLS
    )
      throw new Error(
        `Extend catalog parity for schema/check/policy declarations on ${config.name}`,
      );
    for (const column of config.columns)
      if (column.generated !== undefined || column.generatedIdentity !== undefined)
        throw new Error(`Extend catalog parity for generated column ${config.name}.${column.name}`);
    const columns = config.columns.map(
      (column) =>
        `${quote(column.name)} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}${defaultClause(column)}`,
    );
    const keys = [
      ...config.primaryKeys.map((key) => key.columns.map((column) => column.name)),
      ...config.columns.filter((column) => column.primary).map((column) => [column.name]),
    ];
    columns.push(...keys.map((key) => `PRIMARY KEY (${key.map(quote).join(",")})`));
    columns.push(
      ...config.uniqueConstraints.map(
        (key) =>
          `UNIQUE${key.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} (${key.columns.map((column) => quote(column.name)).join(",")})`,
      ),
    );
    columns.push(
      ...config.columns
        .filter((column) => column.isUnique)
        .map(
          (column) =>
            `UNIQUE${column.uniqueType === "not distinct" ? " NULLS NOT DISTINCT" : ""} (${quote(column.name)})`,
        ),
    );
    statements.push(`CREATE TABLE parity_model.${quote(config.name)} (${columns.join(",")})`);
  }
  for (const config of configs) {
    for (const key of config.foreignKeys) {
      const reference = key.reference();
      statements.push(
        `ALTER TABLE parity_model.${quote(config.name)} ADD FOREIGN KEY (${reference.columns.map((column) => quote(column.name)).join(",")}) REFERENCES parity_model.${quote(getTableConfig(reference.foreignTable).name)} (${reference.foreignColumns.map((column) => quote(column.name)).join(",")}) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate}`,
      );
    }
    for (const index of config.indexes) {
      const configIndex = index.config;
      if (configIndex.with !== undefined && Object.keys(configIndex.with).length > 0)
        throw new Error(`Extend catalog parity for index options on ${configIndex.name}`);
      if (configIndex.name === undefined)
        throw new Error("Schema indexes must have explicit names");
      const columns = configIndex.columns.map((column) => {
        if (is(column, SQL)) return `(${expression(column)})`;
        if (!is(column, IndexedColumn)) throw new Error("Unsupported schema index expression");
        const operator = column.indexConfig.opClass ? ` ${column.indexConfig.opClass}` : "";
        const order =
          !configIndex.method || configIndex.method === "btree"
            ? ` ${column.indexConfig.order ?? "asc"} NULLS ${column.indexConfig.nulls ?? "last"}`
            : "";
        return `${quote(column.name)}${operator}${order}`;
      });
      statements.push(
        `CREATE ${configIndex.unique ? "UNIQUE " : ""}INDEX ${quote(configIndex.name)} ON ${configIndex.only ? "ONLY " : ""}parity_model.${quote(config.name)} USING ${configIndex.method ?? "btree"} (${columns.join(",")})${configIndex.where ? ` WHERE ${expression(configIndex.where)}` : ""}`,
      );
    }
  }
  return statements;
};

type Column = {
  schema: string;
  table_name: string;
  name: string;
  type: string;
  not_null: boolean;
  default_expr: string | null;
};
type Constraint = { schema: string; table_name: string; kind: string; definition: string };
type Index = {
  schema: string;
  table_name: string;
  name: string;
  method: string;
  unique: boolean;
  nulls_not_distinct: boolean;
  predicate: string | null;
  keys: string[];
  operator_classes: string[];
};
const unqualify = (value: string | null) =>
  value
    ?.replaceAll("REFERENCES parity_model.", "REFERENCES ")
    .replaceAll("nextval('parity_model.", "nextval('") ?? null;

describe.skipIf(postgres.skip)(
  "Drizzle declarations against the migrated PostgreSQL catalog",
  () => {
    beforeAll(async () => {
      await withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`CREATE DATABASE ${quote(database)}`);
          created = true;
        }),
      );
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ))
            yield* migration;
          for (const ddl of modelDdl()) yield* sql.unsafe(ddl);
        }),
      );
    });
    afterAll(async () => {
      if (!created) return;
      await withAdmin(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`DROP DATABASE ${quote(database)} WITH (FORCE)`);
        }),
      );
    });

    it("keeps project values and Slack tokens sealed in both the model and migrated tables", async () => {
      const columns = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ table_name: string; column_name: string }>`
          SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name IN ('project_secrets','slack_installs')`;
        }),
      );
      for (const names of [
        columns
          .filter((column) => column.table_name === "project_secrets")
          .map((column) => column.column_name),
        getTableConfig(tables.projectSecrets).columns.map((column) => column.name),
      ]) {
        expect(names).toContain("sealed_value");
        expect(names).not.toContain("value");
      }
      for (const names of [
        columns
          .filter((column) => column.table_name === "slack_installs")
          .map((column) => column.column_name),
        getTableConfig(tables.slackInstalls).columns.map((column) => column.name),
      ])
        expect(names.filter((name) => name.includes("token")).toSorted()).toEqual([
          "sealed_app_token",
          "sealed_bot_token",
        ]);
    });

    it("every declared column has the migrated SQL name, type, nullability and default", async () => {
      const columns = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<Column>`SELECT n.nspname AS schema, c.relname AS table_name,
        a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
        a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_expr
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname IN ('public','parity_model') AND c.relkind='r'
          AND a.attnum>0 AND NOT a.attisdropped`;
        }),
      );
      const model = columns.filter((column) => column.schema === "parity_model");
      expect(model.length).toBe(
        configs.reduce((count, config) => count + config.columns.length, 0),
      );
      const actual = new Map(
        columns
          .filter((column) => column.schema === "public")
          .map(({ schema: _, ...column }) => [`${column.table_name}.${column.name}`, column]),
      );
      for (const { schema: _, ...column } of model)
        expect(
          actual.get(`${column.table_name}.${column.name}`),
          `${column.table_name}.${column.name}`,
        ).toEqual({ ...column, default_expr: unqualify(column.default_expr) });
    });

    it("declared primary keys, unique constraints and foreign-key actions exist in migrations", async () => {
      const constraints = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<Constraint>`SELECT n.nspname AS schema, c.relname AS table_name,
        co.contype AS kind, pg_get_constraintdef(co.oid) AS definition
        FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','parity_model') AND co.contype IN ('p','u','f')`;
        }),
      );
      const actual = constraints
        .filter((row) => row.schema === "public")
        .map(({ schema: _, ...row }) => row);
      const model = constraints.filter((row) => row.schema === "parity_model");
      expect(model.length).toBeGreaterThan(0);
      for (const { schema: _, ...row } of model)
        expect(actual, `${row.table_name}: ${row.definition}`).toContainEqual({
          ...row,
          definition: unqualify(row.definition),
        });
    });

    it("declared indexes match migrated keys, operator classes, uniqueness, method and predicates", async () => {
      const indexes = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<Index>`SELECT n.nspname AS schema, t.relname AS table_name,
        c.relname AS name, am.amname AS method, i.indisunique AS unique,
        i.indnullsnotdistinct AS nulls_not_distinct, pg_get_expr(i.indpred,i.indrelid) AS predicate,
        ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true)
          FROM generate_series(1,i.indnkeyatts) AS k ORDER BY k) AS keys,
        ARRAY(SELECT op.opcname FROM unnest(i.indclass) WITH ORDINALITY AS key(oid,position)
          JOIN pg_opclass op ON op.oid=key.oid ORDER BY key.position) AS operator_classes
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        JOIN pg_am am ON am.oid=c.relam WHERE n.nspname IN ('public','parity_model')
          AND NOT EXISTS (SELECT 1 FROM pg_constraint co
            WHERE co.conindid=i.indexrelid AND co.contype IN ('p','u'))`;
        }),
      );
      const actual = new Map(
        indexes
          .filter((row) => row.schema === "public")
          .map(({ schema: _, ...row }) => [row.name, row]),
      );
      const model = indexes.filter((row) => row.schema === "parity_model");
      expect(model.length).toBe(
        configs.reduce((count, config) => count + config.indexes.length, 0),
      );
      for (const { schema: _, ...row } of model)
        expect(actual.get(row.name), row.name).toEqual({
          ...row,
          predicate: unqualify(row.predicate),
        });
    });
  },
);

// Migrations remain authoritative. Auth-owned tables, retained legacy columns, cyclic FKs,
// CHECK constraints and migration-only indexes need not be declared in the runtime model.
// Repository/migration behavior tests enforce those rules; this checks every declared model
// member against a real fresh migration, not complete bidirectional schema ownership.
