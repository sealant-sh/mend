import { PgClient } from "@effect/sql-pg";
import {
  defaultSettings,
  inheritedOrganizationSettings,
  MendSettings,
  OrganizationId,
  OrganizationSettings,
} from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  OrganizationSettingsRepo,
  OrganizationSettingsRepoLive,
} from "../src/repos/organization-settings.ts";
import { SettingsRepo, SettingsRepoLive } from "../src/repos/settings.ts";

/**
 * An organization's own defaults (docs/adr/0003-organizations-and-tenancy.md) against the dev
 * Postgres (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip
 * rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_org_settings_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(OrganizationSettingsRepoLive, SettingsRepoLive).pipe(
  Layer.provideMerge(MendDBLive),
  Layer.provideMerge(scratchLayer),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, OrganizationSettingsRepo | SettingsRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

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

const ACME = OrganizationId.make("org-acme");
const GLOBEX = OrganizationId.make("org-globex");

const fedora = {
  mode: "family" as const,
  os: "fedora" as const,
  packages: ["jq", "ripgrep"],
  shell: "zsh" as const,
  services: { docker: false },
};

describe.skipIf(!reachable)("organization settings, in Postgres", () => {
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
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ACME}, 'Acme')`;
        yield* sql`INSERT INTO organizations (id, name) VALUES (${GLOBEX}, 'Globex')`;
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

  it("reads nothing set, saves, rewrites under the latest values, and clears", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* OrganizationSettingsRepo;
        expect(yield* repo.get(ACME)).toEqual(inheritedOrganizationSettings);

        const saved = new OrganizationSettings({
          ...inheritedOrganizationSettings,
          workspaceImage: fedora,
          autoLand: true,
          autoName: false,
        });
        yield* repo.set(ACME, saved);
        expect(yield* repo.get(ACME)).toEqual(saved);

        const modified = yield* repo.modify(
          ACME,
          (latest) => new OrganizationSettings({ ...latest, autoTour: false }),
        );
        expect(modified.autoTour).toBe(false);
        expect(modified.workspaceImage).toEqual(fedora);
        expect(yield* repo.get(ACME)).toEqual(modified);

        yield* repo.set(ACME, new OrganizationSettings({ ...modified, workspaceImage: null }));
        expect((yield* repo.get(ACME)).workspaceImage).toBeNull();

        yield* repo.clear(ACME);
        expect(yield* repo.get(ACME)).toEqual(inheritedOrganizationSettings);
      }),
    );
  });

  it("creates the row on a first modify, and serializes concurrent ones", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* OrganizationSettingsRepo;
        yield* Effect.all(
          [
            repo.modify(
              GLOBEX,
              (latest) => new OrganizationSettings({ ...latest, autoTour: true }),
            ),
            repo.modify(
              GLOBEX,
              (latest) => new OrganizationSettings({ ...latest, autoName: true }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const both = yield* repo.get(GLOBEX);
        expect(both.autoTour).toBe(true);
        expect(both.autoName).toBe(true);
        yield* repo.clear(GLOBEX);
      }),
    );
  });

  it("gives each organization its own values over the instance's, and nobody else's", async () => {
    await run(
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        const repo = yield* OrganizationSettingsRepo;
        yield* settings.modify(
          () => new MendSettings({ ...defaultSettings, autoLand: false, autoSuggest: true }),
        );
        yield* repo.set(
          ACME,
          new OrganizationSettings({
            ...inheritedOrganizationSettings,
            workspaceImage: fedora,
            autoLand: true,
          }),
        );

        const acme = yield* settings.forOrganization(ACME);
        expect(acme.autoLand).toBe(true);
        expect(acme.workspaceImage).toEqual(fedora);
        expect(acme.autoSuggest).toBe(true);

        const globex = yield* settings.forOrganization(GLOBEX);
        expect(globex.autoLand).toBe(false);
        expect(globex.workspaceImage).toEqual(defaultSettings.workspaceImage);

        // The instance document is untouched by an organization's values.
        expect((yield* settings.get()).autoLand).toBe(false);
        yield* repo.clear(ACME);
      }),
    );
  });

  it("goes with its organization", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* OrganizationSettingsRepo;
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-gone', 'Gone')`;
        yield* repo.set(
          OrganizationId.make("org-gone"),
          new OrganizationSettings({ ...inheritedOrganizationSettings, autoTour: false }),
        );
        yield* sql`DELETE FROM organizations WHERE id = 'org-gone'`;
        const rows = yield* sql`SELECT organization_id FROM organization_settings`;
        expect(rows).toEqual([]);
      }),
    );
  });
});
