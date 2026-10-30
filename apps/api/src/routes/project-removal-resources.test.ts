import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  ProjectHasResourcesError,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectRemovalFenceId } from "@mend/domain";
import { ResourceDefinitionInput, withPresetCommand } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const project = ids("private-alice").project;
const postgres = postgresTestConfig();

describe("removing a project that has resources", () => {
  let api: TenancyApi | undefined;
  afterEach(async () => {
    await api?.dispose();
    api = undefined;
  });

  const removeWith = async (names: ReadonlyArray<string>) => {
    const lifted: Array<ProjectRemovalFenceId> = [];
    api = await createTenancyApi(undefined, {
      implement: {
        resources: {
          fenceProjectRemoval: (projectId) =>
            names.length === 0
              ? Effect.succeed(ProjectRemovalFenceId.make("rfen_this-removal"))
              : Effect.fail(new ProjectHasResourcesError({ projectId, names })),
          liftProjectRemovalFence: (fence) =>
            Effect.sync(() => {
              lifted.push(fence);
            }),
        },
        store: { removeProjectStore: () => Effect.succeed({ leftover: null }) },
      },
    });
    const response = await api.request("alice", "DELETE", `/api/projects/${project}`);
    return { response, calls: [...api.world.calls], lifted };
  };

  it("is refused with the resources named, before any session stops or the store goes", async () => {
    const { response, calls, lifted } = await removeWith(["db", "queue"]);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      _tag: "StoreFailure",
      message: "project has resources (@db, @queue) · remove them first",
    });
    expect(calls).toEqual(["resources.fenceProjectRemoval"]);
    expect(lifted).toEqual([]);
  });

  it("lifts its own fence when the removal stops before the project's row goes", async () => {
    const { calls, lifted } = await removeWith([]);
    // The harness leaves session listing unimplemented, so the removal stops there.
    expect(calls).toEqual([
      "resources.fenceProjectRemoval",
      "sessions.listForProject",
      "resources.liftProjectRemovalFence",
    ]);
    expect(lifted).toEqual(["rfen_this-removal"]);
  });
});

const pgLayer = (url: string) => PgClient.layer({ url: Redacted.make(url), maxConnections: 6 });

const scratchDatabase = async () => {
  const name = `mend_project_removal_${process.pid}_${Date.now()}`;
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${name}`;
  const admin = (statement: string) =>
    Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
        Effect.provide(pgLayer(postgres.adminUrl)),
        Effect.scoped,
        Effect.asVoid,
      ),
    );
  await admin(`CREATE DATABASE ${name}`);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ResourcesRepoLive, ProjectsRepoLive).pipe(
      Layer.provideMerge(MendDBLive),
      Layer.provideMerge(pgLayer(url.toString())),
    ),
  );
  const drop = async () => {
    await runtime.dispose();
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  };
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-a', 'A')`;
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${project}, 'api', '/store/api', 'main', 'org-a')`;
      }),
    );
  } catch (error) {
    await drop();
    throw error;
  }
  return { runtime, drop };
};

/** A store whose removals each wait to be told how they end, in the order they began. */
const heldStore = () => {
  const removals: Array<{ readonly end: (outcome: "fails" | "succeeds") => void }> = [];
  const waiters: Array<() => void> = [];
  return {
    removeProjectStore: () =>
      Effect.callback<{ readonly leftover: string | null }>((resume) => {
        removals.push({
          end: (outcome) =>
            resume(
              outcome === "succeeds"
                ? Effect.succeed({ leftover: null })
                : Effect.die(new Error("the store could not be removed")),
            ),
        });
        for (const wake of waiters.splice(0)) wake();
      }),
    /** The `n`th removal to reach the store, once it has. */
    removal: async (n: number) => {
      while (removals.length < n) await new Promise<void>((wake) => waiters.push(wake));
      const removal = removals[n - 1];
      if (removal === undefined) throw new Error(`removal ${n} never reached the store`);
      return removal;
    },
  };
};

describe.skipIf(postgres.skip)("two removals of one project, in Postgres", () => {
  let api: TenancyApi | undefined;
  let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
  afterEach(async () => {
    await api?.dispose();
    await database?.drop();
    api = undefined;
    database = undefined;
  });

  it("one that fails leaves the other fenced: a declaration is refused, and the other removes the project", async () => {
    database = await scratchDatabase();
    const { runtime } = database;
    const { resources, projects } = await runtime.runPromise(
      Effect.all({ resources: ResourcesRepo, projects: ProjectsRepo }),
    );
    const store = heldStore();
    api = await createTenancyApi(undefined, {
      implement: {
        resources,
        projects: { remove: projects.remove },
        sessions: { listForProject: () => Effect.succeed([]) },
        forwards: { listOpen: () => Effect.succeed([]) },
        hotWorkspaces: { listForProject: () => Effect.succeed([]) },
        store: { removeProjectStore: store.removeProjectStore },
      },
    });
    const remove = () => api?.request("alice", "DELETE", `/api/projects/${project}`);

    const first = remove();
    const firstAtStore = await store.removal(1);
    const second = remove();
    const secondAtStore = await store.removal(2);

    firstAtStore.end("fails");
    expect((await first)?.status).toBe(500);

    const spec = withPresetCommand(
      Schema.decodeUnknownSync(ResourceDefinitionInput)({
        name: "db",
        scope: "project",
        preset: "postgres",
        image: "postgres:17",
        command: null,
        ports: [{ name: "postgres", port: 5432, protocol: "tcp" }],
        env: {},
        volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
        ready: { kind: "preset" },
        exports: {},
      }),
    );
    const declared = await runtime.runPromise(
      resources.declare(project, spec, "alice").pipe(Effect.result),
    );
    expect(Result.isFailure(declared) ? declared.failure : "accepted").toMatchObject({
      _tag: "ResourceDefinitionRefusedError",
      refusals: [{ key: "project" }],
    });

    secondAtStore.end("succeeds");
    expect((await second)?.status).toBe(200);
    const left = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly projects: number; readonly fences: number }>`
          SELECT (SELECT count(*)::int FROM projects WHERE id = ${project}) AS projects,
                 (SELECT count(*)::int FROM project_removal_fences) AS fences`;
      }),
    );
    expect(left).toEqual([{ projects: 0, fences: 0 }]);
  }, 60_000);
});
