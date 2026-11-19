import { PgClient } from "@effect/sql-pg";
import {
  defaultSettings,
  defaultPersonSettings,
  defaultWorkspaceImage,
  newOrganizationSettings,
  MendSettings,
  OrganizationId,
  OrganizationSettings,
  PersonSettings,
} from "@mend/domain";
import { NO_SESSION_DEFAULTS, SessionDefaults } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  OrganizationSettingsRepo,
  OrganizationSettingsRepoLive,
} from "../src/repos/organization-settings.ts";
import { PersonSettingsRepo, PersonSettingsRepoLive } from "../src/repos/person-settings.ts";
import { SessionDefaultsRepo, SessionDefaultsRepoLive } from "../src/repos/session-defaults.ts";
import { SettingsRepo, SettingsRepoLive } from "../src/repos/settings.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_person_settings_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = Layer.mergeAll(
  OrganizationSettingsRepoLive,
  PersonSettingsRepoLive,
  SessionDefaultsRepoLive,
  SettingsRepoLive,
).pipe(
  Layer.provideMerge(MendDBLive),
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) })),
);

type Repos =
  | OrganizationSettingsRepo
  | PersonSettingsRepo
  | SessionDefaultsRepo
  | SettingsRepo
  | SqlClient.SqlClient;
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const ACME = OrganizationId.make("org-acme");

describe.skipIf(postgres.skip)("a person's own settings, in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ACME}, 'Acme')`;
        for (const id of ["anna", "ben", "cleo"]) {
          yield* sql`INSERT INTO "user" ("id", "name", "email", "createdAt")
            VALUES (${id}, ${id}, ${`${id}@example.com`}, '2026-01-01T00:00:00Z')`;
        }
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`,
        );
      }),
    );
  });

  it("gives each person's sessions their own switches, never the organization's or the instance's", async () => {
    await run(
      Effect.gen(function* () {
        const settings = yield* SettingsRepo;
        const people = yield* PersonSettingsRepo;
        // The instance turns landing on and the tour off; Acme turns suggestions off. Both are
        // still stored for the old web app, and neither may reach anyone's sessions.
        yield* settings.modify(
          () => new MendSettings({ ...defaultSettings, autoTour: false, autoLand: true }),
        );
        yield* (yield* OrganizationSettingsRepo).set(
          ACME,
          new OrganizationSettings({
            ...newOrganizationSettings(defaultWorkspaceImage),
            autoSuggest: false,
          }),
        );
        expect(yield* people.forUser("anna")).toEqual(defaultPersonSettings);
        // Anna saves her own; Ben never saved.
        const annas = new PersonSettings({
          ...defaultPersonSettings,
          autoTour: false,
          autoLand: true,
        });
        expect(yield* people.set("anna", annas)).toEqual(annas);

        const anna = yield* settings.forPerson(ACME, "anna");
        expect([anna.autoTour, anna.autoSuggest, anna.autoLand]).toEqual([false, true, true]);

        const ben = yield* settings.forPerson(ACME, "ben");
        expect([ben.autoTour, ben.autoSuggest, ben.autoLand]).toEqual([true, true, false]);

        // A session with no owner gets Mend's defaults too.
        const nobody = yield* settings.forPerson(ACME, null);
        expect([nobody.autoTour, nobody.autoSuggest, nobody.autoLand]).toEqual([true, true, false]);
      }),
    );
  });

  it("saves new-session defaults, and keeps a browser's own only when none are saved", async () => {
    await run(
      Effect.gen(function* () {
        const defaults = yield* SessionDefaultsRepo;
        expect(yield* defaults.forUser("cleo")).toEqual(NO_SESSION_DEFAULTS);

        const laptop = new SessionDefaults({
          harness: "codex",
          byHarness: { codex: { model: "gpt-6.1-sol", effort: "high" } },
        });
        const phone = new SessionDefaults({ harness: "claude", byHarness: {} });
        // The first browser to hand its defaults over wins; a second changes nothing.
        expect(yield* defaults.adopt("cleo", laptop)).toEqual({ saved: laptop, adopted: true });
        expect(yield* defaults.adopt("cleo", phone)).toEqual({ saved: laptop, adopted: false });

        // A save from Settings replaces them.
        const chosen = new SessionDefaults({
          harness: "pi",
          byHarness: { pi: { model: null, effort: "low" } },
        });
        expect(yield* defaults.set("cleo", chosen)).toEqual(chosen);
        expect(yield* defaults.forUser("cleo")).toEqual(chosen);
        expect(yield* defaults.adopt("cleo", laptop)).toEqual({ saved: chosen, adopted: false });
      }),
    );
  });

  it("goes with its person", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* PersonSettingsRepo).set(
          "ben",
          new PersonSettings({ ...defaultPersonSettings, autoName: false }),
        );
        yield* (yield* SessionDefaultsRepo).set(
          "ben",
          new SessionDefaults({ harness: "codex", byHarness: {} }),
        );
        yield* sql`DELETE FROM "user" WHERE id = 'ben'`;
        expect(
          yield* sql`SELECT user_id FROM user_automation_settings WHERE user_id = 'ben'`,
        ).toEqual([]);
        expect(yield* sql`SELECT user_id FROM user_session_defaults WHERE user_id = 'ben'`).toEqual(
          [],
        );
      }),
    );
  });
});
