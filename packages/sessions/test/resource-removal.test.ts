import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourceArchivesRepo,
  ResourceArchivesRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, ProjectId, WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  ownDatabaseName,
  baseDatabaseName,
  presetDefinition,
  PresetVersion,
  ResourceName,
  resourceInstanceSpec,
} from "@mend/domain/workbench";
import { ResourceScopes, type ResourceScope, type ScopeInstance } from "@mend/sealant";
import { Effect, Layer, ManagedRuntime, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ResourceRemoval, ResourceRemovalLive } from "../src/resources/removal.ts";

const postgres = postgresTestConfig();
const database = `mend_resource_removal_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const pg = PgClient.layer({ url: Redacted.make(url.toString()) });
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const PROJECT = ProjectId.make("p-removal");
const WORKTREE = WorktreeId.make("w-removal");
const ORG = OrganizationId.make("org-removal");
const OWN = ownDatabaseName(WORKTREE);

/** Records commands at the platform boundary and remembers files/databases across retries. */
const calls: Array<{ readonly key: string; readonly argv: ReadonlyArray<string> }> = [];
const saved = new Set<string>();
const dropped = new Set<string>();
const archivedKeys: Array<string> = [];
const instances = new Map<string, ScopeInstance>();
let failCheck = "";
let failAfterDrop = false;
let scopeArchives = 0;
const scope: ResourceScope = {
  id: "scope-removal",
  get: (key) => Effect.succeed(instances.get(key) ?? null),
  list: (archived) =>
    Effect.succeed(
      [...instances.values()].filter(
        (instance) => (instance.state.kind === "archived") === (archived === true),
      ),
    ),
  up: (key, spec, cause) =>
    Effect.sync(() => {
      expect(cause).toBe("person");
      const instance: ScopeInstance = {
        id: key,
        key,
        alias: spec.alias,
        worktreeKey: spec.worktreeKey,
        desired: "running",
        state: { kind: "running", since: new Date() },
        specDigest: "d",
        stopReason: null,
        observedAt: new Date(),
        startedAt: null,
        lastReachedAt: null,
        volumes: [{ name: "data", dockerName: `${key}-data` }],
      };
      instances.set(key, instance);
      return instance;
    }),
  stop: () => Effect.die("unused"),
  link: () => Effect.void,
  exec: (key, options) =>
    Effect.sync(() => {
      calls.push({ key, argv: options.argv });
      const script = options.argv[2] ?? "";
      const path = options.argv[5] ?? "";
      let failed = false;
      if (script.includes("pg_dump")) {
        if (key === failCheck) failed = true;
        else saved.add(`${key}:${path}`);
      }
      if (script.includes("drop database")) {
        expect(saved.has(`${key}:${path}`)).toBe(true);
        dropped.add(key);
        if (failAfterDrop) {
          failed = true;
          failAfterDrop = false;
        }
      }
      return {
        exitCode: failed ? 1 : 0,
        stdout: "",
        stderr: failed ? "dump check refused" : "",
        timedOut: false,
        truncated: false,
      };
    }),
  archive: (key) =>
    Effect.sync(() => {
      archivedKeys.push(key);
      const instance = instances.get(key);
      if (instance)
        instances.set(key, { ...instance, state: { kind: "archived", at: new Date() } });
      return (instance?.volumes ?? []).map((volume) => ({
        ...volume,
        instanceKey: key,
        bytes: 4096,
      }));
    }),
  archiveScope: () =>
    Effect.sync(() => {
      scopeArchives += 1;
      return [...instances.values()]
        .filter((instance) => instance.state.kind !== "archived")
        .flatMap((instance) =>
          instance.volumes.map((volume) => ({ ...volume, instanceKey: instance.key, bytes: 8192 })),
        );
    }),
};
const scopes = Layer.succeed(ResourceScopes, { of: () => Effect.succeed(scope) });
const repos = Layer.mergeAll(ResourcesRepoLive, ProjectsRepoLive, ResourceArchivesRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pg))),
);
const runtime = ManagedRuntime.make(
  ResourceRemovalLive.pipe(Layer.provideMerge(Layer.merge(repos, scopes))),
);
const adminSql = (statement: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
      Effect.provide(admin),
      Effect.scoped,
    ),
  );

const remove = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const project = yield* (yield* ProjectsRepo).byId(PROJECT);
      return yield* (yield* ResourceRemoval).worktree(project, WORKTREE);
    }).pipe(Effect.result),
  );

const seed = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`TRUNCATE resource_archives, resource_kept_volumes, resource_definitions CASCADE`;
      const repo = yield* ResourcesRepo;
      const definitions = [];
      for (const name of ["db", "other"]) {
        const spec = presetDefinition({
          name: ResourceName.make(name),
          preset: "postgres",
          version: PresetVersion.make("17"),
        });
        const identity = yield* repo.ensureIdentity(PROJECT, name);
        const definition = yield* repo.remember(
          PROJECT,
          identity.id,
          null,
          spec,
          ImageDigest.make(`sha256:${"a".repeat(64)}`),
          "alice",
        );
        yield* repo.recordOwnDatabase(WORKTREE, definition.id, "empty");
        definitions.push(definition);
      }
      return definitions;
    }),
  );

describe.skipIf(postgres.skip)("resource preservation before removal", () => {
  beforeAll(async () => {
    await adminSql(`CREATE DATABASE ${database}`);
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ORG}, 'Resources')`;
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('alice', 'Alice', 'alice@removal.invalid', now())`;
        yield* sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${ORG}, 'alice', 'owner')`;
        yield* sql`INSERT INTO projects (id, name, organization_id, created_by_user_id, store_path, default_branch, visibility) VALUES (${PROJECT}, 'app', ${ORG}, 'alice', '/store/app', 'main', 'shared')`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES (${WORKTREE}, ${PROJECT}, 'work', 'work', 'work', 'abc')`;
      }),
    );
  }, 60_000);
  beforeEach(() => {
    calls.length = 0;
    saved.clear();
    dropped.clear();
    instances.clear();
    failCheck = "";
    failAfterDrop = false;
    scopeArchives = 0;
    archivedKeys.length = 0;
  });
  afterAll(async () => {
    await runtime.dispose();
    await adminSql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  it("starts stopped servers for removal, checks every dump, drops, records, and retries without dropping again", async () => {
    await seed();
    const first = await remove();
    expect(Result.isSuccess(first) ? first.success : first.failure).toEqual([
      expect.stringContaining("its own database saved as a dump"),
      expect.stringContaining("its own database saved as a dump"),
    ]);
    expect(
      Result.isSuccess(first) &&
        first.success.every((line) => line.includes("removal started its server")),
    ).toBe(true);
    expect(dropped.size).toBe(2);
    const phases = calls
      .filter((call) => call.argv[2]?.includes("pg_restore"))
      .map((call) => (call.argv[2]?.includes("pg_dump") ? "save" : "drop"));
    expect(phases).toEqual(["save", "save", "drop", "drop"]);
    const rows = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(WORKTREE)),
    );
    expect(
      rows.every(
        (row) =>
          row.removedAt !== null &&
          row.checkedAt !== null &&
          row.dumpName?.includes(`${OWN}-removed-`),
      ),
    ).toBe(true);
    calls.length = 0;
    expect(Result.isSuccess(await remove())).toBe(true);
    expect(calls).toEqual([]);
  });

  it("saves a forgotten base database beside own databases before dropping any of them", async () => {
    const [definition] = await seed();
    if (definition === undefined) throw new Error("missing fixture");
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) =>
        repo.recordOwnDatabase(WORKTREE, definition.id, "copied", "base"),
      ),
    );
    const result = await remove();
    expect(Result.isSuccess(result) && result.success.join(" ")).toContain(
      "base copy database saved as a dump",
    );
    const commands = calls.filter((call) => call.argv[2]?.includes("pg_restore"));
    expect(commands.map((call) => (call.argv[2]?.includes("pg_dump") ? "save" : "drop"))).toEqual([
      "save",
      "save",
      "save",
      "drop",
      "drop",
      "drop",
    ]);
    const base = commands.filter((call) => call.argv[4] === baseDatabaseName(WORKTREE));
    expect(base).toHaveLength(2);
    expect(base[0]?.argv[5]).toContain(`${baseDatabaseName(WORKTREE)}-removed-`);
    const rows = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(WORKTREE)),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.removedAt !== null && row.checkedAt !== null)).toBe(true);
  });

  it("a failed check for the second database refuses removal and drops nothing; retry uses the reserved dumps", async () => {
    const definitions = await seed();
    failCheck = definitions.at(-1)?.id ?? "";
    const first = await remove();
    expect(Result.isFailure(first) ? first.failure.message : "removed").toContain(
      "dump or dump check failed",
    );
    expect(dropped.size).toBe(0);
    const before = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(WORKTREE)),
    );
    failCheck = "";
    expect(Result.isSuccess(await remove())).toBe(true);
    const after = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(WORKTREE)),
    );
    expect(after.map((row) => row.dumpName)).toEqual(before.map((row) => row.dumpName));
    expect(dropped.size).toBe(2);
  });

  it("a retry after a drop with a lost reply reuses its checked dump", async () => {
    await seed();
    failAfterDrop = true;
    expect(Result.isFailure(await remove())).toBe(true);
    expect(dropped.size).toBe(1);
    expect(Result.isSuccess(await remove())).toBe(true);
    expect(dropped.size).toBe(2);
    expect(saved.size).toBe(2);
  });

  it("uses a checked dump with an archived server even while the remembered instance row remains", async () => {
    const definitions = await seed();
    const at = new Date();
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ResourcesRepo;
        for (const definition of definitions) {
          yield* repo.reserveRemovalDump(
            WORKTREE,
            definition.id,
            `${OWN}-removed-20261101T120000Z.dump`,
            at,
          );
          yield* repo.checkRemovalDump(WORKTREE, definition.id, at);
          yield* scope.up(
            definition.id,
            resourceInstanceSpec({
              definition: definition.spec,
              image: definition.image,
              worktreeId: null,
            }),
            "person",
          );
          yield* scope.archive(definition.id);
        }
      }),
    );
    const result = await remove();
    expect(
      Result.isSuccess(result) && result.success.every((line) => line.includes("saved when @")),
    ).toBe(true);
    expect(calls).toEqual([]);
    expect(dropped.size).toBe(0);
    const rows = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(WORKTREE)),
    );
    expect(rows.every((row) => row.removedAt !== null)).toBe(true);
  });

  it("refuses removal after the server row is gone when its reserved dump was not checked", async () => {
    const definitions = await seed();
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ResourcesRepo;
        for (const definition of definitions) {
          yield* repo.reserveRemovalDump(
            WORKTREE,
            definition.id,
            `${OWN}-removed-20261101T120000Z.dump`,
            new Date(),
          );
          yield* repo.removeInstance(definition.id, null);
        }
      }),
    );
    expect(Result.isFailure(await remove())).toBe(true);
    expect(calls).toEqual([]);
    const rows = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(WORKTREE)),
    );
    expect(rows.every((row) => row.removedAt === null)).toBe(true);
  });

  it("archives only this worktree's instances and keeps the others", async () => {
    const [definition] = await seed();
    if (definition === undefined) throw new Error("missing fixture");
    const ownKey = `${definition.id}@${WORKTREE}`;
    const otherKey = `${definition.id}@other`;
    await runtime.runPromise(
      scope.up(
        ownKey,
        resourceInstanceSpec({
          definition: definition.spec,
          image: definition.image,
          worktreeId: WORKTREE,
        }),
        "person",
      ),
    );
    await runtime.runPromise(
      scope.up(
        otherKey,
        resourceInstanceSpec({
          definition: definition.spec,
          image: definition.image,
          worktreeId: WorktreeId.make("other"),
        }),
        "person",
      ),
    );
    expect(Result.isSuccess(await remove())).toBe(true);
    expect(archivedKeys).toEqual([ownKey]);
    expect(instances.get(ownKey)?.volumes).toHaveLength(1);
    expect(instances.get(otherKey)?.state.kind).toBe("running");
    const kept = await runtime.runPromise(
      Effect.flatMap(ResourceArchivesRepo, (repo) => repo.keptVolumes(PROJECT)),
    );
    expect(kept).toEqual([expect.objectContaining({ instanceKey: ownKey, bytes: 4096 })]);
    await runtime.runPromise(
      Effect.flatMap(ResourceArchivesRepo, (repo) =>
        repo.rememberVolumes(
          PROJECT,
          kept.map((volume) => ({ ...volume, bytes: null })),
        ),
      ),
    );
    const project = await runtime.runPromise(
      Effect.flatMap(ProjectsRepo, (repo) => repo.byId(PROJECT)),
    );
    await runtime.runPromise(
      Effect.flatMap(ResourceRemoval, (removal) => removal.project(project)),
    );
    const archived = await runtime.runPromise(
      Effect.flatMap(ResourceArchivesRepo, (repo) => repo.byProject(PROJECT)),
    );
    expect(archived?.archive.volumes).toContainEqual(
      expect.objectContaining({ instanceKey: ownKey, bytes: 4096 }),
    );
  });

  it("archives a worktree-only resource and removes its remembered row", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`TRUNCATE resource_archives, resource_kept_volumes, resource_definitions CASCADE`;
        const repo = yield* ResourcesRepo;
        const spec = presetDefinition({
          name: ResourceName.make("cache"),
          preset: "redis",
          version: PresetVersion.make("8"),
        });
        const identity = yield* repo.ensureIdentity(PROJECT, "cache");
        const row = yield* repo.remember(
          PROJECT,
          identity.id,
          WORKTREE,
          spec,
          ImageDigest.make(`sha256:${"a".repeat(64)}`),
          "alice",
        );
        yield* scope.up(
          `${identity.id}@${WORKTREE}`,
          resourceInstanceSpec({ definition: spec, image: row.image, worktreeId: WORKTREE }),
          "person",
        );
      }),
    );
    const result = await remove();
    expect(Result.isSuccess(result)).toBe(true);
    expect(archivedKeys).toHaveLength(1);
    const rows = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.listForProject(PROJECT)),
    );
    expect(rows).toEqual([]);
    const kept = await runtime.runPromise(
      Effect.flatMap(ResourceArchivesRepo, (repo) => repo.keptVolumes(PROJECT)),
    );
    expect(kept).toHaveLength(1);
  });

  it("records the project inventory before archiving, retains measured sizes and never archives twice", async () => {
    const definitions = await seed();
    for (const definition of definitions)
      await runtime.runPromise(
        scope.up(
          definition.id,
          resourceInstanceSpec({
            definition: definition.spec,
            image: definition.image,
            worktreeId: null,
          }),
          "person",
        ),
      );
    const project = await runtime.runPromise(
      Effect.flatMap(ProjectsRepo, (repo) => repo.byId(PROJECT)),
    );
    await runtime.runPromise(
      Effect.flatMap(ResourceRemoval, (removal) => removal.project(project)),
    );
    const archive = await runtime.runPromise(
      Effect.flatMap(ResourceArchivesRepo, (repo) => repo.byProject(PROJECT)),
    );
    expect(archive?.complete).toBe(true);
    expect(archive?.archive).toMatchObject({
      projectName: "app",
      createdByUserId: "alice",
      organizationId: ORG,
      volumes: [expect.objectContaining({ bytes: 8192 }), expect.objectContaining({ bytes: 8192 })],
    });
    await runtime.runPromise(
      Effect.flatMap(ResourceRemoval, (removal) => removal.project(project)),
    );
    expect(scopeArchives).toBe(1);
  });
});
