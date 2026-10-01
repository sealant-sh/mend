import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { PiProfilesRepo, PiProfilesRepoLive, piProfileDigest } from "../src/repos/pi-profiles.ts";

/**
 * Each person's pi setup, against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway
 * database. Without one reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL
 * elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_pi_profiles_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = PiProfilesRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, PiProfilesRepo | SqlClient.SqlClient>) =>
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

const settings = JSON.stringify({
  theme: "github-dark-default",
  packages: ["npm:pi-web-access@0.23.0", { source: "./mend/profile/packages/pi-usage" }],
});
const profile = [
  { path: "settings.json", encoding: "utf8", contents: settings },
  {
    path: "extensions/git-info/index.ts",
    encoding: "utf8",
    contents: "export default () => {};\n",
  },
  { path: "extensions/save-md.ts", encoding: "utf8", contents: "export default () => {};\n" },
  { path: "extensions/git-info/banner.png", encoding: "base64", contents: "iVBORw0KGgo=" },
] as const;

describe.skipIf(!reachable)("pi profiles, in Postgres", () => {
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

  it("saves a profile whole, says what it holds, and leaves an identical save alone", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* PiProfilesRepo;
        expect(yield* repo.forUser("anna")).toBeNull();

        const first = yield* repo.save("anna", profile);
        expect(first.changed).toBe(true);
        expect(first.profile).toMatchObject({
          fileCount: 4,
          extensions: ["git-info", "save-md.ts"],
          packages: ["npm:pi-web-access@0.23.0", "./mend/profile/packages/pi-usage"],
          digest: piProfileDigest(profile),
          revision: 1,
        });
        // The PNG's eight bytes count as eight, not as its base64.
        expect(first.profile.bytes).toBe(
          settings.length + 2 * "export default () => {};\n".length + 8,
        );

        // The same files in another order: nothing to save.
        const again = yield* repo.save("anna", profile.toReversed());
        expect(again.changed).toBe(false);
        expect(again.profile.revision).toBe(1);

        const smaller = yield* repo.save("anna", profile.slice(0, 2));
        expect(smaller.changed).toBe(true);
        expect(smaller.profile).toMatchObject({ fileCount: 2, revision: 2 });
        const stored = yield* repo.forUser("anna");
        expect(stored?.files.map((file) => file.path)).toEqual([
          "extensions/git-info/index.ts",
          "settings.json",
        ]);
        expect(yield* repo.forUser("ben")).toBeNull();
      }),
    );
  });

  it("refuses a file outside the profile's layout, and a path that climbs out", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* PiProfilesRepo;
        for (const path of ["auth.json", "extensions/../auth.json", "/etc/passwd", "sessions/x"]) {
          const refused = yield* repo
            .save("ben", [{ path, encoding: "utf8", contents: "{}" }])
            .pipe(Effect.flip);
          expect(refused._tag).toBe("PiProfileInvalidError");
        }
        expect(yield* repo.forUser("ben")).toBeNull();
      }),
    );
  });

  it("removes a profile, and goes with the account", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* PiProfilesRepo;
        expect(yield* repo.remove("anna")).toBe(true);
        expect(yield* repo.remove("anna")).toBe(false);
        yield* repo.save("ben", profile);
        yield* sql`DELETE FROM "user" WHERE id = 'ben'`;
        expect(yield* sql`SELECT user_id FROM user_pi_profiles WHERE user_id = 'ben'`).toEqual([]);
      }),
    );
  });
});
