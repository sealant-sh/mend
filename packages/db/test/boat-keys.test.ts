import { PgClient } from "@effect/sql-pg";
import { OrganizationId } from "@mend/domain";
import type { BoatKeyOwner } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { BoatKeysRepo, BoatKeysRepoLive } from "../src/repos/boat-keys.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_boat_keys_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = BoatKeysRepoLive.pipe(
  Layer.provideMerge(
    MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) }))),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, BoatKeysRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
const OTHER = OrganizationId.make("org-other");

describe.skipIf(postgres.skip)("Boat keys (SLNT-790)", () => {
  let acme = OrganizationId.make("");
  const owner = (): BoatKeyOwner => ({ kind: "organization", organizationId: acme });

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    acme = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
            ('bob', 'Bob', 'bob@example.com', '2026-01-02T00:00:00Z')`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        yield* sql`INSERT INTO organizations (id, name) VALUES (${OTHER}, 'Other')`;
        return OrganizationId.make(organization?.id ?? "");
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

  it("keeps one key per organization, names it for launches, and forgets it on removal", async () => {
    await run(
      Effect.gen(function* () {
        const keys = yield* BoatKeysRepo;
        expect(yield* keys.accountForLaunch(acme, "alice")).toBeNull();
        const connected = yield* keys.connect({
          owner: owner(),
          sealantBoatAccountId: "core-boat-acme",
          connectedByUserId: "alice",
        });
        expect(connected).toMatchObject({
          owner: owner(),
          sealantBoatAccountId: "core-boat-acme",
          connectedByUserId: "alice",
          keyReplacedAt: null,
        });
        // A second connect for the same organization loses: one key per owner.
        const second = yield* keys
          .connect({
            owner: owner(),
            sealantBoatAccountId: "core-boat-late",
            connectedByUserId: "bob",
          })
          .pipe(Effect.flip);
        expect(second._tag).toBe("BoatKeyTakenError");
        // Every launch in the organization names it, whoever launches; another organization's
        // launches do not.
        expect(yield* keys.accountForLaunch(acme, "alice")).toBe("core-boat-acme");
        expect(yield* keys.accountForLaunch(acme, "bob")).toBe("core-boat-acme");
        expect(yield* keys.accountForLaunch(acme, null)).toBe("core-boat-acme");
        expect(yield* keys.accountForLaunch(OTHER, "alice")).toBeNull();

        const replaced = yield* keys.markReplaced(owner());
        expect(replaced?.keyReplacedAt).toBeInstanceOf(Date);
        expect(replaced?.sealantBoatAccountId).toBe("core-boat-acme");

        expect((yield* keys.remove(owner()))?.sealantBoatAccountId).toBe("core-boat-acme");
        expect(yield* keys.remove(owner())).toBeNull();
        expect(yield* keys.accountForLaunch(acme, "alice")).toBeNull();
      }),
    );
  });

  it("takes a person's own key over the organization's once one is stored", async () => {
    await run(
      Effect.gen(function* () {
        const keys = yield* BoatKeysRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* keys.connect({
          owner: owner(),
          sealantBoatAccountId: "core-boat-org",
          connectedByUserId: "alice",
        });
        // No route writes a person's key yet (SLNT-797); the table already holds one.
        yield* sql`
          INSERT INTO boat_keys (id, organization_id, owner_user_id, sealant_boat_account_id, connected_by_user_id)
          VALUES ('person-key', ${acme}, 'bob', 'core-boat-bob', 'bob')`;
        expect(yield* keys.accountForLaunch(acme, "bob")).toBe("core-boat-bob");
        expect(yield* keys.accountForLaunch(acme, "alice")).toBe("core-boat-org");
        // The organization's own key is the row without a person.
        expect((yield* keys.byOwner(owner()))?.sealantBoatAccountId).toBe("core-boat-org");
        yield* sql`DELETE FROM boat_keys`;
      }),
    );
  });
});
