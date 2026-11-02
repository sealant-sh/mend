import { PgClient } from "@effect/sql-pg";
import { SealantIdentityStore } from "@mend/sealant";
import { Effect, Layer, Redacted, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import { SealantIdentityStoreLive } from "../src/repos/sealant-identities.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_sealant_identity_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
// Match PgLive: the identity reader must consume the transformed result names.
const pool = PgClient.layer({
  url: Redacted.make(scratchUrl.toString()),
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
});
const live = SealantIdentityStoreLive.pipe(Layer.provideMerge(pool));
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SealantIdentityStore | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live), Effect.scoped));

describe.skipIf(postgres.skip)(
  "Sealant identity mappings through the live SQL naming policy",
  () => {
    beforeAll(async () => {
      await withAdmin(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)),
      );
      await run(
        Effect.gen(function* () {
          const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
          yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
        VALUES ('identity-person', 'Identity Person', 'identity@localhost.test', now())`;
        }),
      );
    });

    afterAll(async () => {
      await withAdmin(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
        ),
      );
    });

    it("returns the recorded identity on every subsequent lookup instead of provisioning again", async () => {
      await run(
        Effect.gen(function* () {
          const identities = yield* SealantIdentityStore;
          expect(yield* identities.sealantUserId("identity-person")).toBeNull();
          yield* identities.record("identity-person", "platform-person");
          for (let n = 0; n < 3; n++) {
            expect(yield* identities.sealantUserId("identity-person")).toBe("platform-person");
          }
          expect(yield* identities.sealantUserId("someone-else")).toBeNull();
        }),
      );
    });
  },
);
