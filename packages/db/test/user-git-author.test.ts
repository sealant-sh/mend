import { PgClient } from "@effect/sql-pg";
import { GitAuthor } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { UserGitAuthorRepo, UserGitAuthorRepoLive } from "../src/repos/user-git-author.ts";

/**
 * docs/GIT-ACCESS.md, "Git author", against the dev Postgres (`compose.dev.yaml`, :5434) in a
 * throwaway database. Without one reachable these skip rather than pretend; set
 * MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_git_author_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = UserGitAuthorRepoLive.pipe(Layer.provideMerge(scratchLayer));

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, UserGitAuthorRepo | SqlClient.SqlClient>) =>
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

describe.skipIf(!reachable)("the git author setting, in Postgres", () => {
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
          VALUES ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z')`;
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

  it("answers the registration name and email until the account saves its own", async () => {
    await run(
      Effect.gen(function* () {
        const authors = yield* UserGitAuthorRepo;
        expect(yield* authors.resolve("anna")).toEqual({
          name: "Anna Example",
          email: "anna@example.com",
          source: "account",
        });

        yield* authors.set(
          "anna",
          new GitAuthor({ name: "Anna E.", email: "1+anna@users.noreply.github.com" }),
        );
        expect(yield* authors.resolve("anna")).toEqual({
          name: "Anna E.",
          email: "1+anna@users.noreply.github.com",
          source: "setting",
        });
        yield* authors.set("anna", new GitAuthor({ name: "Anna", email: "anna@work.example" }));
        expect((yield* authors.resolve("anna"))?.email).toBe("anna@work.example");

        yield* authors.clear("anna");
        expect((yield* authors.resolve("anna"))?.source).toBe("account");
        expect(yield* authors.resolve("nobody")).toBeNull();
      }),
    );
  });

  it("goes with the account", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const authors = yield* UserGitAuthorRepo;
        yield* authors.set("anna", new GitAuthor({ name: "Anna", email: "anna@work.example" }));
        yield* sql`DELETE FROM "user" WHERE id = 'anna'`;
        const rows = yield* sql`SELECT user_id FROM user_git_author`;
        expect(rows).toEqual([]);
      }),
    );
  });
});
