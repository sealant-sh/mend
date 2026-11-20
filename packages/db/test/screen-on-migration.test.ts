import { PgClient } from "@effect/sql-pg";
import { builtInSettingsFor, defaultWorkspaceImage } from "@mend/domain";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it } from "vitest";

import { BuiltInSettings } from "../src/built-in-settings.ts";
import { migrations } from "../src/migrations.ts";
import { postgresTestConfig } from "./postgres.ts";

/**
 * 0234 gives the agent's screen to every saved image nobody edited, and leaves every image someone
 * changed as it is. Each case seeds a server as it stood before, in its own database.
 */
const config = postgresTestConfig();
const MIGRATION = "0234_screen_on";
const made: Array<string> = [];

const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(config.adminUrl) })),
      Effect.scoped,
    ),
  );

/** Mend's built-in image as it was saved before 0234: no screen. */
const untouched = { ...defaultWorkspaceImage, screen: false };

const upgraded = async (
  seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  architecture: "x86_64" | "aarch64",
) => {
  const database = `mend_screen_on_${process.pid}_${Date.now()}_${made.length}`;
  made.push(database);
  await admin(`CREATE DATABASE ${database}`);
  const url = new URL(config.adminUrl);
  url.pathname = `/${database}`;
  const layer = PgClient.layer({ url: Redacted.make(url.toString()) });
  const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(work.pipe(Effect.provide(layer), Effect.scoped));
  await run(
    Effect.gen(function* () {
      const builtIn = builtInSettingsFor(null, architecture);
      const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
      for (const [name, migration] of ordered)
        if (name < MIGRATION)
          yield* migration.pipe(Effect.provideService(BuiltInSettings, builtIn));
      yield* seed;
      yield* migrations[MIGRATION].pipe(Effect.provideService(BuiltInSettings, builtIn));
    }),
  );
  return {
    project: (id: string) =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{ readonly image: unknown }>`SELECT workspace_image AS image FROM projects
            WHERE id = ${id}`,
        ),
      ).then((rows) => rows[0]?.image),
    organization: (id: string) =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{ readonly image: unknown }>`SELECT workspace_image AS image
            FROM organization_settings WHERE organization_id = ${id}`,
        ),
      ).then((rows) => rows[0]?.image),
    instance: () =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{ readonly image: unknown }>`SELECT value->'workspaceImage' AS image FROM settings
            WHERE key = 'mend'`,
        ),
      ).then((rows) => rows[0]?.image),
  };
};

const organization = (id: string, image: unknown) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.andThen(
      sql`INSERT INTO organizations (id, name) VALUES (${id}, ${id})`,
      sql`INSERT INTO organization_settings (organization_id, workspace_image)
        VALUES (${id}, ${JSON.stringify(image)}::jsonb)`,
    ),
  );

const project = (id: string, organizationId: string, image: unknown) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
      workspace_image) VALUES (${id}, ${id}, ${`/store/${id}`}, 'main', ${organizationId},
      ${JSON.stringify(image)}::jsonb)`,
  );

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO settings (key, value) VALUES ('mend', ${JSON.stringify({
    prMode: "draft-immediately",
    concurrency: 1,
    workspaceImage: untouched,
  })}::jsonb)`;
  yield* organization("acme", untouched);
  yield* organization("beta", { ...untouched, shell: "bash" });
  yield* project("default", "acme", untouched);
  // Mend picked Ubuntu without Docker for a Boat runtime: nobody edited it either.
  yield* project("on-boat", "acme", { ...untouched, os: "ubuntu", services: { docker: false } });
  yield* project("own-packages", "acme", { ...untouched, packages: ["jq"] });
  yield* project("custom", "acme", {
    mode: "custom",
    baseImage: "node:22-bookworm",
    packages: [],
    setupCommands: [],
    services: { docker: true },
  });
});

afterAll(async () => {
  for (const database of made) await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}, 60_000);

describe.skipIf(config.skip)("0234: the agent's screen is on by default", () => {
  it("turns the screen on in every image nobody edited, and leaves edited ones alone", async () => {
    const server = await upgraded(seed, "x86_64");
    expect(await server.instance()).toEqual(defaultWorkspaceImage);
    expect(await server.organization("acme")).toEqual(defaultWorkspaceImage);
    expect(await server.project("default")).toEqual(defaultWorkspaceImage);
    expect(await server.project("on-boat")).toMatchObject({ os: "ubuntu", screen: true });
    expect(await server.organization("beta")).toMatchObject({ shell: "bash", screen: false });
    expect(await server.project("own-packages")).toMatchObject({ packages: ["jq"], screen: false });
    expect(await server.project("custom")).not.toHaveProperty("screen");
  }, 120_000);

  it("changes no image on a server that can't run a screen", async () => {
    const server = await upgraded(seed, "aarch64");
    expect(await server.instance()).toEqual(untouched);
    expect(await server.organization("acme")).toEqual(untouched);
    expect(await server.project("default")).toEqual(untouched);
  }, 120_000);
});
