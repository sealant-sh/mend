import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { UserDotfilesRepo, UserDotfilesRepoLive } from "../src/repos/user-dotfiles.ts";

/**
 * "Start my agents after install.sh" (docs/adr/0016, decision 11), against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip rather
 * than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_user_dotfiles_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = UserDotfilesRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, UserDotfilesRepo | SqlClient.SqlClient>) =>
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

describe.skipIf(!reachable)("a person's dotfiles settings, in Postgres", () => {
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

  it("is off for anyone, with or without a row, until they turn it on, and keeps their repository", async () => {
    await run(
      Effect.gen(function* () {
        const dotfiles = yield* UserDotfilesRepo;
        expect(yield* dotfiles.startAgentsAfterInstall("anna")).toBe(false);
        const repository = {
          url: "https://github.com/anna/dotfiles",
          ref: null,
          subdirectory: null,
          manager: "stow" as const,
          bootstrap: true,
        };
        yield* dotfiles.setRepository("anna", repository);
        expect(yield* dotfiles.startAgentsAfterInstall("anna")).toBe(false);
        yield* dotfiles.setStartAgentsAfterInstall("anna", true);
        expect(yield* dotfiles.startAgentsAfterInstall("anna")).toBe(true);
        expect(yield* dotfiles.repository("anna")).toEqual(repository);
        // Someone with no row yet gets one, holding no repository.
        yield* dotfiles.setStartAgentsAfterInstall("bob", true);
        expect(yield* dotfiles.startAgentsAfterInstall("bob")).toBe(true);
        expect(yield* dotfiles.repository("bob")).toBeNull();
        // A repository saved afterwards leaves the setting as it is.
        yield* dotfiles.setRepository("bob", repository);
        expect(yield* dotfiles.startAgentsAfterInstall("bob")).toBe(true);
        yield* dotfiles.setStartAgentsAfterInstall("anna", false);
        expect(yield* dotfiles.startAgentsAfterInstall("anna")).toBe(false);
      }),
    );
  });
});
