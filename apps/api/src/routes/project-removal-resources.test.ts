import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  ProjectsRepo,
  ProjectsRepoLive,
  RemovalFencesRepo,
  RemovalFencesRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ResourceDefinitionInput } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const project = ids("private-alice").project;
const worktree = ids("private-alice").worktree;
const postgres = postgresTestConfig();

/** What a project removal reads about its one worktree: nothing runs, saves or is past its base. */
const quietWorktree = (changed: ReadonlyArray<string> = []) =>
  ({
    engine: { launchUnderWay: () => false, captureHolds: () => Effect.succeed([]) },
    forwards: { listOpen: () => Effect.succeed([]) },
    reads: {
      changedFiles: () =>
        Effect.succeed({
          value: changed.map((path) => ({ path, additions: 1, deletions: 0 })),
          stamp: WORKTREE_STAMP,
        }),
    },
    landings: { listForChange: () => Effect.succeed([]) },
    hotWorkspaces: { listForProject: () => Effect.succeed([]) },
  }) as const;

describe("removing a project that has resources", () => {
  let api: TenancyApi | undefined;
  afterEach(async () => {
    await api?.dispose();
    api = undefined;
  });

  const removeWith = async (names: ReadonlyArray<string>, changed: ReadonlyArray<string> = []) => {
    api = await createTenancyApi(undefined, {
      implement: {
        ...quietWorktree(changed),
        resources: { declaredNames: () => Effect.succeed(names) },
        store: { removeProjectStore: () => Effect.succeed({ leftover: null }) },
      },
    });
    const response = await api.request("alice", "DELETE", `/api/projects/${project}`);
    return { response, calls: [...api.world.calls] };
  };

  it("is refused with the resources named beside every other blocker, and the store stays", async () => {
    const { response, calls } = await removeWith(["db", "queue"], ["src/a.ts"]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      _tag: "RemovalRefused",
      scope: "project",
      blockers: [
        { _tag: "Unlanded", worktreeId: worktree },
        { _tag: "ResourcesDeclared", names: ["db", "queue"] },
      ],
    });
    expect(calls.filter((call) => call.startsWith("store."))).toEqual([]);
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
    Layer.mergeAll(ResourcesRepoLive, ProjectsRepoLive, RemovalFencesRepoLive).pipe(
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

  it("refuses a second removal while one deletes; a failed deletion stays fenced, and the next removal finishes it", async () => {
    database = await scratchDatabase();
    const { runtime } = database;
    const { resources, projects, removalFences } = await runtime.runPromise(
      Effect.all({
        resources: ResourcesRepo,
        projects: ProjectsRepo,
        removalFences: RemovalFencesRepo,
      }),
    );
    const store = heldStore();
    api = await createTenancyApi(undefined, {
      implement: {
        ...quietWorktree(),
        resources,
        removalFences,
        projects: { remove: projects.remove },
        store: { removeProjectStore: store.removeProjectStore },
      },
    });
    const remove = () => api?.request("alice", "DELETE", `/api/projects/${project}`);

    const first = remove();
    const firstAtStore = await store.removal(1);
    const second = await remove();
    expect(second?.status).toBe(409);
    expect(await second?.json()).toMatchObject({ blockers: [{ _tag: "RemovalUnderway" }] });

    firstAtStore.end("fails");
    expect((await first)?.status).toBe(500);

    const spec = Schema.decodeUnknownSync(ResourceDefinitionInput)({
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
    });
    const declared = await runtime.runPromise(
      resources.declare(project, spec, "alice").pipe(Effect.result),
    );
    expect(Result.isFailure(declared) ? declared.failure : "accepted").toMatchObject({
      _tag: "ResourceDefinitionRefusedError",
      refusals: [{ key: "project" }],
    });

    const third = remove();
    const thirdAtStore = await store.removal(2);
    thirdAtStore.end("succeeds");
    expect((await third)?.status).toBe(200);
    const left = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly projects: number }>`
          SELECT count(*)::int AS projects FROM projects WHERE id = ${project}`;
      }),
    );
    expect(left).toEqual([{ projects: 0 }]);
  }, 60_000);
});
