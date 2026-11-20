import { PgClient } from "@effect/sql-pg";
import { builtInSettingsFor, defaultWorkspaceImage } from "@mend/domain";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, describe, expect, it } from "vitest";

import { BuiltInSettings } from "../src/built-in-settings.ts";
import { migrations } from "../src/migrations.ts";
import { postgresTestConfig } from "./postgres.ts";

/**
 * 0230 turns every image left to follow a level above into the one it resolved to, so no session's
 * image changes on upgrade. Each case seeds a server as it stood before, in its own database.
 */
const config = postgresTestConfig();
const MIGRATION = "0230_workspace_image_own";
const made: Array<string> = [];

const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(config.adminUrl) })),
      Effect.scoped,
    ),
  );

const fedora = {
  mode: "family",
  os: "fedora",
  packages: ["jq"],
  shell: "zsh",
  services: { docker: false },
  screen: false,
};
const custom = {
  mode: "custom",
  baseImage: "node:22-bookworm",
  packages: [],
  setupCommands: ["corepack enable"],
  services: { docker: true },
};

/** A database migrated to just before 0230, seeded, then migrated by it on a `runtime` server. */
const upgraded = async (
  seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  runtime: "docker" | "boat" = "docker",
) => {
  const database = `mend_image_own_${process.pid}_${Date.now()}_${made.length}`;
  made.push(database);
  await admin(`CREATE DATABASE ${database}`);
  const url = new URL(config.adminUrl);
  url.pathname = `/${database}`;
  const layer = PgClient.layer({ url: Redacted.make(url.toString()) });
  const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(work.pipe(Effect.provide(layer), Effect.scoped));
  await run(
    Effect.gen(function* () {
      const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
      for (const [name, migration] of ordered) if (name < MIGRATION) yield* migration;
      yield* seed;
      yield* migrations[MIGRATION].pipe(
        Effect.provideService(BuiltInSettings, builtInSettingsFor(runtime, "x86_64")),
      );
    }),
  );
  const image = (table: "projects" | "organization_settings", key: string, id: string) =>
    run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly workspace_image: unknown }>`SELECT workspace_image FROM ${sql(table)}
          WHERE ${sql(key)} = ${id}`,
      ),
    ).then((rows) => rows[0]?.workspace_image);
  return {
    run,
    project: (id: string) => image("projects", "id", id),
    organization: (id: string) => image("organization_settings", "organization_id", id),
  };
};

const organizations = (...ids: ReadonlyArray<string>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(ids, (id) => sql`INSERT INTO organizations (id, name) VALUES (${id}, ${id})`, {
      discard: true,
    }),
  );

const project = (id: string, organizationId: string, image: unknown = null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
      workspace_image) VALUES (${id}, ${id}, ${`/store/${id}`}, 'main', ${organizationId},
      ${image === null ? null : JSON.stringify(image)}::jsonb)`,
  );

afterAll(async () => {
  for (const database of made) await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}, 60_000);

describe.skipIf(config.skip)("0230: a project's workspace image becomes its own copy", () => {
  it("keeps what each image resolved to: the project's own, else its organization's, else the server's document", async () => {
    const server = await upgraded(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The operator saved a document whose image is a custom base.
        yield* sql`INSERT INTO settings (key, value) VALUES ('mend', ${JSON.stringify({
          prMode: "draft-immediately",
          concurrency: 1,
          workspaceImage: custom,
        })}::jsonb)`;
        // Acme set Fedora; Beta has a row that set no image; Gamma has no row at all.
        yield* organizations("acme", "beta", "gamma");
        yield* sql`INSERT INTO organization_settings (organization_id, workspace_image)
          VALUES ('acme', ${JSON.stringify(fedora)}::jsonb)`;
        yield* sql`INSERT INTO organization_settings (organization_id, auto_land)
          VALUES ('beta', true)`;
        yield* project("acme-follows", "acme");
        yield* project("acme-own", "acme", { ...fedora, os: "nix" });
        yield* project("beta-follows", "beta");
        yield* project("gamma-follows", "gamma");
      }),
    );
    expect(await server.organization("acme")).toEqual(fedora);
    expect(await server.organization("beta")).toEqual(custom);
    expect(await server.organization("gamma")).toEqual(custom);
    expect(await server.project("acme-follows")).toEqual(fedora);
    expect(await server.project("acme-own")).toEqual({ ...fedora, os: "nix" });
    expect(await server.project("beta-follows")).toEqual(custom);
    expect(await server.project("gamma-follows")).toEqual(custom);
    // Nothing can follow a level above any more.
    await expect(
      server.run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`UPDATE projects SET workspace_image = NULL WHERE id = 'acme-own'`,
        ),
      ),
    ).rejects.toThrow();
  }, 120_000);

  it("copies the built-in image for the server's runtime where the operator saved nothing: Ubuntu on Boat, Arch on Docker", async () => {
    const seed = Effect.gen(function* () {
      yield* organizations("acme");
      yield* project("follows", "acme");
    });
    const boat = await upgraded(seed, "boat");
    const docker = await upgraded(seed, "docker");
    expect(await boat.organization("acme")).toMatchObject({ mode: "family", os: "ubuntu" });
    expect(await boat.project("follows")).toMatchObject({ mode: "family", os: "ubuntu" });
    expect(await docker.project("follows")).toEqual(defaultWorkspaceImage);
  }, 120_000);
});
