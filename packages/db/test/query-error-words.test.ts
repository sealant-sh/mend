import { readFileSync } from "node:fs";
import { inspect } from "node:util";

import { PgClient } from "@effect/sql-pg";
import { sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Logger, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDB, MendDBLive } from "../src/client.ts";
import { isRemovalFenced, isRemovalStopped } from "../src/repos/removal-fences.ts";
import {
  isDriverError,
  isForeignKeyViolation,
  uniqueViolationConstraint,
} from "../src/repos/unique-violation.ts";
import { postgresTestConfig } from "./postgres.ts";

/** One token, so that Postgres quotes all of it where it quotes a JSON token it refused. */
const WORDS = "Anna_is_interviewing_at_Northwind_on_Friday_5c2e";

const postgres = postgresTestConfig();
const database = `mend_query_error_words_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pool = PgClient.layer({ url: Redacted.make(scratchUrl.toString()) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, MendDB | SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(MendDBLive.pipe(Layer.provideMerge(pool))), Effect.scoped),
  );

const renderings = (error: Error): Record<string, string> => {
  const logged: Array<string> = [];
  const capture = Logger.layer([
    Logger.map(Logger.formatJson, (line) => logged.push(line)),
    Logger.map(Logger.formatLogFmt, (line) => logged.push(line)),
    Logger.map(Logger.formatSimple, (line) => logged.push(line)),
  ]);
  Effect.runSync(Effect.logError("a query failed", Cause.die(error)).pipe(Effect.provide(capture)));
  let thrown = "";
  try {
    Effect.runSync(Effect.die(error));
  } catch (reason) {
    thrown = reason instanceof Error ? `${String(reason)}\n${reason.stack}` : String(reason);
  }
  return {
    string: String(error),
    template: `${error}`,
    message: error.message,
    stack: error.stack ?? "",
    json: JSON.stringify(error),
    inspect: inspect(error, { depth: Number.POSITIVE_INFINITY }),
    causeString: String(Cause.die(error)),
    causePretty: Cause.pretty(Cause.die(error)),
    exitString: String(Exit.die(error)),
    thrown,
    log: logged.join("\n"),
  };
};

const failed = (statement: ReturnType<typeof sql>) =>
  run(
    Effect.gen(function* () {
      const db = yield* MendDB;
      return yield* db.execute(statement).pipe(Effect.flip);
    }),
  );

describe.skipIf(postgres.skip)("a failed query's parameters (SLNT-385)", () => {
  let created = false;
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
        created = true;
      }),
    );
    await run(
      Effect.gen(function* () {
        const client = yield* SqlClient.SqlClient;
        for (const statement of [
          "CREATE TABLE people (id text PRIMARY KEY)",
          `CREATE TABLE notes (
             id text PRIMARY KEY,
             author text NOT NULL REFERENCES people (id),
             words text NOT NULL,
             pages integer NOT NULL CHECK (pages > 0),
             shape jsonb
           )`,
          "CREATE TABLE fenced (words text NOT NULL)",
          "CREATE TABLE stopped (words text NOT NULL)",
          "CREATE TABLE titles (words text UNIQUE)",
          `CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             RAISE EXCEPTION 'refused by the test' USING ERRCODE = 'MRFEN';
           END $$`,
          `CREATE FUNCTION refuse_stopped() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             RAISE EXCEPTION 'refused by the test' USING ERRCODE = 'MRFES';
           END $$`,
          "CREATE TRIGGER refuse BEFORE INSERT ON fenced FOR EACH ROW EXECUTE FUNCTION refuse()",
          "CREATE TRIGGER refuse BEFORE INSERT ON stopped FOR EACH ROW EXECUTE FUNCTION refuse_stopped()",
          "INSERT INTO people VALUES ('anna')",
          "INSERT INTO notes VALUES ('note-1', 'anna', 'first', 1)",
        ]) {
          yield* client.unsafe(statement);
        }
        yield* client`INSERT INTO titles VALUES (${WORDS})`;
      }),
    );
  });
  afterAll(async () => {
    if (!created) return;
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }),
    );
  });

  it.each([
    [
      "refused by a trigger",
      sql`insert into fenced (words) values (${WORDS})`,
      "params: 1 withheld (string)",
      (error: unknown) =>
        expect([isRemovalFenced(error), isRemovalStopped(error)]).toEqual([true, false]),
    ],
    [
      "refused by a stopped deletion's trigger",
      sql`insert into stopped (words) values (${WORDS})`,
      "params: 1 withheld (string)",
      (error: unknown) =>
        expect([isRemovalFenced(error), isRemovalStopped(error)]).toEqual([true, true]),
    ],
    [
      "a unique violation",
      sql`insert into notes (id, author, words, pages) values (${"note-1"}, ${"anna"}, ${WORDS}, ${3})`,
      "params: 4 withheld (string, string, string, number)",
      (error: unknown) => expect(uniqueViolationConstraint(error)).toBe("notes_pkey"),
    ],
    [
      "a unique violation of a key that holds the words",
      sql`insert into titles (words) values (${WORDS})`,
      "params: 1 withheld (string)",
      (error: unknown) => expect(uniqueViolationConstraint(error)).toBe("titles_words_key"),
    ],
    [
      "a null in a column that refuses one",
      sql`insert into notes (id, author, words, pages) values (${"note-3"}, ${"anna"}, ${WORDS}, ${null})`,
      "params: 4 withheld (string, string, string, null)",
      (error: unknown) => expect(isDriverError(error, "23502")).toBe(true),
    ],
    [
      "a check constraint's refusal",
      sql`insert into notes (id, author, words, pages) values (${"note-4"}, ${"anna"}, ${WORDS}, ${0})`,
      "params: 4 withheld (string, string, string, number)",
      (error: unknown) => expect(isDriverError(error, "23514")).toBe(true),
    ],
    [
      "words that are not the column's type",
      sql`insert into notes (id, author, words, pages) values (${"note-5"}, ${"anna"}, ${"first"}, ${WORDS})`,
      "params: 4 withheld (string, string, string, string)",
      (error: unknown) => expect(isDriverError(error, "22P02")).toBe(true),
    ],
    [
      "words that are not JSON",
      sql`insert into notes (id, author, words, pages, shape) values (${"note-6"}, ${"anna"}, ${"first"}, ${1}, ${WORDS})`,
      "params: 5 withheld (string, string, string, number, string)",
      (error: unknown) => expect(isDriverError(error, "22P02")).toBe(true),
    ],
    [
      "a foreign key violation",
      sql`insert into notes (id, author, words, pages) values (${"note-2"}, ${"maria"}, ${WORDS}, ${3})`,
      "params: 4 withheld (string, string, string, number)",
      (error: unknown) => expect(isForeignKeyViolation(error)).toBe(true),
    ],
  ])("never renders a parameter when %s", async (_, statement, withheld, recovers) => {
    const error = await failed(statement);
    expect(error._tag).toBe("EffectDrizzleQueryError");
    recovers(error);
    const holding = Object.entries(renderings(error)).filter(([, text]) => text.includes(WORDS));
    expect(holding.map(([form]) => form)).toEqual([]);
    expect(error.message).toBe(`Failed query: ${error.query}\n${withheld}`);
  });
});

describe("Drizzle in the lockfile (SLNT-385)", () => {
  it("is patched in every copy, so no copy holds a failed query's parameters", () => {
    const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const snapshots = lockfile.slice(lockfile.indexOf("\nsnapshots:\n"));
    const copies = snapshots.split("\n").filter((line) => /^ {2}'?drizzle-orm@/.test(line));
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.filter((line) => !line.includes("(patch_hash="))).toEqual([]);
  });
});
