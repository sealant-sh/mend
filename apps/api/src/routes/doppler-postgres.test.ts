import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { DopplerRepo, DopplerRepoLive, MendDBLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectId } from "@mend/domain";
import { MendKeysConfig, SecretCipher, SecretCipherLive } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const postgres = postgresTestConfig();
const database = `mend_doppler_test_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pg = PgClient.layer({ url: Redacted.make(url.toString()) });
const keys = fs.mkdtempSync(path.join(os.tmpdir(), "mend-doppler-keys-"));
const dependencies = Layer.mergeAll(
  DopplerRepoLive.pipe(Layer.provide(MendDBLive)),
  SecretCipherLive.pipe(Layer.provide(MendKeysConfig.layerFor(keys))),
).pipe(Layer.provideMerge(pg));
const runAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));

describe.skipIf(postgres.skip)("Doppler HTTP with Postgres and real SecretCipher", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    DopplerRepo | SecretCipher | PgClient.PgClient | SqlClient.SqlClient,
    SqlError.SqlError
  >;
  let api: TenancyApi;
  beforeAll(async () => {
    await runAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    runtime = ManagedRuntime.make(dependencies);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('carol', 'Carol', 'carol@doppler.invalid', now()), ('bob', 'Bob', 'bob@doppler.invalid', now())`;
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id) VALUES (${ids("shared-a").project}, 'shared-a', '/store/doppler', 'main', (SELECT id FROM organizations LIMIT 1))`;
      }),
    );
    const repo = await runtime.runPromise(DopplerRepo);
    const cipher = await runtime.runPromise(SecretCipher);
    api = await createTenancyApi(undefined, { implement: { doppler: repo, cipher } });
  });
  afterAll(async () => {
    await api?.dispose();
    await runtime?.dispose();
    await runAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }),
    );
    fs.rmSync(keys, { recursive: true, force: true });
  });
  it("stores only ciphertext, isolates accounts, upserts selections and cascades disconnect", async () => {
    const token = "dp.ct.fake-postgres-canary";
    expect((await api.request("carol", "PUT", "/api/me/doppler", { token })).status).toBe(200);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          sealed_token: string;
        }>`SELECT sealed_token FROM user_doppler_connections WHERE user_id = 'carol'`;
        expect(JSON.stringify(rows)).not.toContain(token);
        expect(rows[0]?.sealed_token).toMatch(/^v1\./);
        const sealed = (yield* (yield* DopplerRepo).connection("carol"))?.sealedToken;
        expect(sealed).toBeDefined();
        if (sealed === undefined) throw new Error("connection missing");
        expect(yield* (yield* SecretCipher).decrypt(sealed)).toBe(token);
      }),
    );
    const mapping = `/api/me/doppler/projects/${ids("shared-a").project}`;
    expect(
      (await api.request("carol", "PUT", mapping, { dopplerProject: "backend", config: "dev" }))
        .status,
    ).toBe(200);
    expect(
      (await api.request("carol", "PUT", mapping, { dopplerProject: "backend", config: "dev_me" }))
        .status,
    ).toBe(200);
    expect(await (await api.request("carol", "GET", "/api/me/doppler")).json()).toMatchObject({
      connected: true,
      mappings: [{ config: "dev_me" }],
    });
    expect(await (await api.request("bob", "GET", "/api/me/doppler")).json()).toEqual({
      connected: false,
      name: null,
      updatedAt: null,
      mappings: [],
    });
    await api.request("carol", "DELETE", "/api/me/doppler");
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* DopplerRepo;
        expect(yield* repo.connection("carol")).toBeNull();
        expect(yield* repo.mappings("carol")).toEqual([]);
        yield* repo.save("bob", "sealed-fixture");
        yield* repo.use("bob", ProjectId.make(ids("shared-a").project), {
          dopplerProject: "backend",
          config: "dev",
        });
        yield* (yield* SqlClient.SqlClient)`DELETE FROM "user" WHERE id = 'bob'`;
        expect(yield* repo.connection("bob")).toBeNull();
        expect(yield* repo.mappings("bob")).toEqual([]);
      }),
    );
  });
});
