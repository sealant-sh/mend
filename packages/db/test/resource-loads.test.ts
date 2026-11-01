import { PgClient } from "@effect/sql-pg";
import { ProjectId, ResourceLoadId } from "@mend/domain";
import { ImageDigest, presetDefinition, PresetVersion, ResourceName } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MendDBLive,
  migrations,
  ResourceLoadsRepo,
  ResourceLoadsRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
  type StoredResourceLoad,
} from "../src/index.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const name = `mend_loads_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${name}`;
const pg = PgClient.layer({ url: Redacted.make(url.toString()) });
const infra = MendDBLive.pipe(Layer.provideMerge(pg));
const layer = Layer.merge(ResourceLoadsRepoLive, ResourcesRepoLive).pipe(Layer.provideMerge(infra));
const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );

describe.skipIf(postgres.skip)("durable resource loads", () => {
  let runtime: ReturnType<
    typeof ManagedRuntime.make<Layer.Success<typeof layer>, Layer.Error<typeof layer>>
  >;
  beforeAll(async () => {
    await admin(`CREATE DATABASE ${name}`);
    runtime = ManagedRuntime.make(layer);
    await runtime.runPromise(
      Effect.gen(function* () {
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO organizations (id,name) VALUES ('load-org','Loads')`;
        yield* sql`INSERT INTO projects(id,name,store_path,default_branch,organization_id) VALUES ('load-project','loads','/store/loads','main','load-org')`;
      }),
    );
  });
  afterAll(async () => {
    await runtime?.dispose();
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
  it("arbitrates concurrent requests for one target and releases it only after a terminal phase", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const definitions = yield* ResourcesRepo;
        const repo = yield* ResourceLoadsRepo;
        const projectId = ProjectId.make("load-project");
        const definition = yield* definitions.declare(
          projectId,
          {
            spec: presetDefinition({
              name: ResourceName.make("db"),
              preset: "postgres",
              version: PresetVersion.make("17"),
              scope: "project",
            }),
            imageDigest: ImageDigest.make(`sha256:${"a".repeat(64)}`),
          },
          "alice",
        );
        const row: StoredResourceLoad = {
          id: ResourceLoadId.make(crypto.randomUUID()),
          projectId,
          definitionId: definition.id,
          worktreeId: null,
          instanceKey: definition.id,
          database: "app",
          target: "shared",
          label: "staging/app",
          startedBy: "alice",
          phase: "receiving",
          bytesDone: 0,
          bytesTotal: 8,
          savedPath: null,
          savedAt: null,
          message: null,
          createdAt: new Date(),
        };
        const outcomes = yield* Effect.all(
          [
            repo.begin(row).pipe(Effect.result),
            repo
              .begin({ ...row, id: ResourceLoadId.make(crypto.randomUUID()) })
              .pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter((r) => r._tag === "Success")).toHaveLength(1);
        expect(outcomes.filter((r) => r._tag === "Failure")).toHaveLength(1);
        const [live] = yield* repo.live();
        expect(live).toBeDefined();
        if (live === undefined) return;
        yield* repo.progress(live.id, 8);
        expect((yield* repo.get(live.id))?.bytesDone).toBe(8);
        yield* repo.advance(live, "failed", { message: "interrupted by a Mend restart" });
        expect((yield* repo.live()).length).toBe(0);
        yield* repo.begin({ ...row, id: ResourceLoadId.make(crypto.randomUUID()) });
        const stored = yield* (yield* SqlClient.SqlClient)`SELECT * FROM resource_loads`;
        expect(
          JSON.stringify(stored, (_, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        ).not.toMatch(/postgres:\/\//);
      }),
    );
  });
});
