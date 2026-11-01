import { PgClient } from "@effect/sql-pg";
import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  ResourceDefinition,
  resourceSpecDigest,
  withPresetCommand,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ResourcesRepo, ResourcesRepoLive } from "../src/repos/resources.ts";
import { WorktreesRepo, WorktreesRepoLive } from "../src/repos/worktrees.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_resources_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = Layer.merge(ResourcesRepoLive, WorktreesRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, ResourcesRepo | WorktreesRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));
const using = <A, E>(use: (repo: ResourcesRepo["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* ResourcesRepo);
  });
const withRepo = <A, E>(use: (repo: ResourcesRepo["Service"]) => Effect.Effect<A, E>) =>
  run(using(use));
const failureOf = <A, E>(use: (repo: ResourcesRepo["Service"]) => Effect.Effect<A, E>) =>
  run(using(use).pipe(Effect.result)).then((outcome) =>
    Result.isFailure(outcome) ? outcome.failure : "accepted",
  );

const decode = Schema.decodeUnknownSync(ResourceDefinition);
const postgresDb = (overrides: Record<string, unknown> = {}) =>
  withPresetCommand(
    decode({
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
      ...overrides,
    }),
  );
const redisCache = () =>
  postgresDb({
    name: "cache",
    preset: "redis",
    image: "redis:8",
    ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
    volumes: [{ name: "data", mountPath: "/data" }],
  });
const mailpit = (scope: "project" | "worktree", name = "mail") =>
  postgresDb({
    name,
    scope,
    preset: null,
    image: "axllent/mailpit:v1.27",
    ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
    volumes: [],
    ready: { kind: "tcp" },
  });

const newProject = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = ProjectId.make(`p-${crypto.randomUUID()}`);
      yield* sql`
        INSERT INTO projects (id, name, store_path, default_branch, organization_id)
        VALUES (${id}, ${id}, ${`/store/${id}/repo.git`}, 'main',
                (SELECT id FROM organizations LIMIT 1))`;
      return id;
    }),
  );

const newWorktree = (project: ProjectId) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = WorktreeId.make(`wt-${crypto.randomUUID()}`);
      yield* sql`
        INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
        VALUES (${id}, ${project}, ${id}, ${id}, ${`mend/${id}`}, 'abc')`;
      return id;
    }),
  );

const count = (table: "resource_selections", definition: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [row] = yield* sql.unsafe<{ readonly n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE definition_id = $1`,
        [definition],
      );
      return row?.n;
    }),
  );

const execute = (statement: string, params: ReadonlyArray<unknown> = []) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe(statement, [...params]);
    }),
  );

const imageDigest = (hex = "a") => ImageDigest.make(`sha256:${hex.repeat(64)}`);
const add = (
  repo: ResourcesRepo["Service"],
  project: ProjectId,
  spec: ResourceDefinition,
  by: string,
  worktreeId: WorktreeId | null = null,
) =>
  Effect.gen(function* () {
    const identity = yield* repo.ensureIdentity(project, spec.name);
    return yield* repo.remember(project, identity.id, worktreeId, spec, imageDigest(), by);
  });
describe.skipIf(postgres.skip)("resources in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("copies the project visibility default only when inserting a worktree", async () => {
    const project = await newProject();
    const create = () =>
      run(
        Effect.gen(function* () {
          const id = WorktreeId.make(`wt-${crypto.randomUUID()}`);
          return yield* (yield* WorktreesRepo).create({
            id,
            projectId: project,
            name: id,
            directory: id,
            branch: `mend/${id}`,
            baseSha: Sha.make("abc"),
            baseRef: null,
            handoff: null,
          });
        }),
      );
    const first = await create();
    expect(first.usesProjectResources).toBe(true);
    await execute("UPDATE projects SET new_worktrees_use_project_resources = false WHERE id = $1", [
      project,
    ]);
    const second = await create();
    expect(second.usesProjectResources).toBe(false);
    expect(
      (await run(Effect.flatMap(WorktreesRepo, (repo) => repo.byId(first.id))))
        .usesProjectResources,
    ).toBe(true);
  });

  it("keeps one identity while remembering independent project and worktree starts", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const first = await withRepo((repo) => add(repo, project, redisCache(), "alice"));
    const own = await withRepo((repo) => add(repo, project, redisCache(), "bob", worktree));
    expect(own.id).toBe(first.id);
    expect(own.worktreeId).toBe(worktree);
    expect(first.specDigest).toBe(resourceSpecDigest(redisCache()));
    expect(first.image).toBe(`redis:8@${imageDigest()}`);
    expect(await withRepo((repo) => repo.listIdentities(project))).toHaveLength(1);
    expect(await withRepo((repo) => repo.listForProject(project))).toHaveLength(2);
  });

  it("refuses invalid definitions, Mend env collisions and resource env collisions", async () => {
    const project = await newProject();
    expect(
      await failureOf((repo) => add(repo, project, postgresDb({ name: "preview" }), "alice")),
    ).toMatchObject({ _tag: "ResourceDefinitionRefusedError", refusals: [{ key: "name" }] });
    await withRepo((repo) =>
      add(
        repo,
        project,
        { ...mailpit("project", "db"), exports: { MAIN_URL: "tcp://{host}" } },
        "alice",
      ),
    );
    expect(
      await failureOf((repo) => add(repo, project, mailpit("project", "db-main"), "alice")),
    ).toMatchObject({ _tag: "ResourceDefinitionRefusedError" });
    expect(await withRepo((repo) => repo.listForProject(project))).toHaveLength(1);
  });

  it("uses visibility defaults and preserves selections when an instance is replaced or removed", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
    expect((await withRepo((repo) => repo.listWithChoices(project, worktree)))[0]?.choice).toBe(
      "project",
    );
    await execute("UPDATE worktrees SET uses_project_resources = false WHERE id = $1", [worktree]);
    expect((await withRepo((repo) => repo.listWithChoices(project, worktree)))[0]?.choice).toBe(
      "off",
    );
    await withRepo((repo) => repo.setSelection(project, worktree, db.id, "worktree", "alice"));
    await withRepo((repo) => add(repo, project, postgresDb({ image: "postgres:18" }), "bob"));
    expect((await withRepo((repo) => repo.listWithChoices(project, worktree)))[0]?.choice).toBe(
      "worktree",
    );
    await withRepo((repo) => repo.removeInstance(db.id, null));
    expect(await count("resource_selections", db.id)).toBe(1);
    expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
  });

  it("refuses selections across project boundaries and allows all three level choices", async () => {
    const project = await newProject();
    const other = await newProject();
    const worktree = await newWorktree(project);
    const elsewhere = await newWorktree(other);
    const cache = await withRepo((repo) => add(repo, project, redisCache(), "alice"));
    for (const mode of ["project", "worktree", "off"] as const)
      expect(
        await withRepo((repo) => repo.setSelection(project, worktree, cache.id, mode, "alice")),
      ).toMatchObject({ mode });
    expect(
      await failureOf((repo) => repo.setSelection(project, elsewhere, cache.id, "off", "alice")),
    ).toMatchObject({ _tag: "ResourceSelectionRefusedError" });
    expect(
      await failureOf((repo) => repo.setSelection(other, elsewhere, cache.id, "off", "alice")),
    ).toMatchObject({ _tag: "ResourceDefinitionNotFoundError" });
  });

  it("keeps own database inventory and its origin when the server instance is removed", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
    await withRepo((repo) => repo.recordOwnDatabase(worktree, db.id, "copied"));
    await withRepo((repo) => repo.removeInstance(db.id, null));
    expect([...(await withRepo((repo) => repo.ownDatabases(worktree)))]).toEqual([
      [db.id, { kind: "copied", at: expect.any(Date) }],
    ]);
  });

  it("tracks own and base databases independently and clears removal progress only on recreation", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
    await withRepo((repo) =>
      Effect.gen(function* () {
        yield* repo.recordOwnDatabase(worktree, db.id, "copied");
        yield* repo.recordOwnDatabase(worktree, db.id, "empty", "base");
        const at = new Date("2026-11-01T12:00:00Z");
        yield* repo.reserveRemovalDump(worktree, db.id, "base.dump", at, false, "base");
        yield* repo.checkRemovalDump(worktree, db.id, at, "base");
        yield* repo.removeOwnDatabase(worktree, db.id, at, "base");
        expect(
          (yield* repo.ownDatabaseRemovals(worktree)).find((row) => row.purpose === "own"),
        ).toMatchObject({
          dumpName: null,
          checkedAt: null,
          removedAt: null,
        });
        expect((yield* repo.ownDatabases(worktree)).get(db.id)?.kind).toBe("copied");
        expect((yield* repo.ownDatabases(worktree, "base")).size).toBe(0);
        yield* repo.recordOwnDatabase(worktree, db.id, "copied", "base");
        expect((yield* repo.ownDatabases(worktree, "base")).get(db.id)?.kind).toBe("copied");
        expect(
          (yield* repo.ownDatabaseRemovals(worktree)).find((row) => row.purpose === "base"),
        ).toMatchObject({
          dumpName: null,
          dumpAt: null,
          checkedAt: null,
          removedAt: null,
        });
        expect((yield* repo.bindingRows(project, worktree)).ownDatabases.size).toBe(1);
        expect((yield* repo.ownSelections(project)).get(db.id)).toBe(1);
        expect(yield* repo.ownDatabasesForResource(db.id)).toHaveLength(2);
      }),
    );
  });

  it("lists only active own databases for archive and refreshes a checked reservation before saving again", async () => {
    const project = await newProject();
    const first = await newWorktree(project);
    const second = await newWorktree(project);
    const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
    await withRepo((repo) =>
      Effect.gen(function* () {
        for (const id of [first, second]) yield* repo.recordOwnDatabase(id, db.id, "empty");
        const at = new Date("2026-11-01T12:00:00Z");
        yield* repo.reserveRemovalDump(first, db.id, "first.dump", at);
        yield* repo.checkRemovalDump(first, db.id, at);
        yield* repo.removeOwnDatabase(first, db.id, at);
        expect(yield* repo.ownDatabasesForResource(db.id)).toEqual([
          { worktreeId: second, worktreeName: second, purpose: "own" },
        ]);
        yield* repo.reserveRemovalDump(second, db.id, "second.dump", at);
        yield* repo.checkRemovalDump(second, db.id, at);
        const later = new Date("2026-11-01T13:00:00Z");
        yield* repo.reserveRemovalDump(second, db.id, "new.dump", later, true);
        expect(yield* repo.ownDatabaseRemovals(second)).toEqual([
          {
            worktreeId: second,
            definitionId: db.id,
            purpose: "own",
            dumpName: "new.dump",
            dumpAt: later,
            checkedAt: null,
            removedAt: null,
          },
        ]);
        // A refresh never revives or clears the check on an already removed database.
        yield* repo.reserveRemovalDump(first, db.id, "ignored.dump", later, true);
        expect((yield* repo.ownDatabaseRemovals(first))[0]?.dumpName).toBe("first.dump");
      }),
    );
  });

  it("holds the project removal fence until checking expires, and always while deleting", async () => {
    const project = await newProject();
    await execute(
      "UPDATE projects SET removal_phase = 'checking', removal_id = 'rmv_test', removal_since = now() WHERE id = $1",
      [project],
    );
    expect(await failureOf((repo) => add(repo, project, postgresDb(), "alice"))).toMatchObject({
      _tag: "ResourceDefinitionRefusedError",
    });
    await execute(
      "UPDATE projects SET removal_since = now() - interval '121 seconds' WHERE id = $1",
      [project],
    );
    expect(await withRepo((repo) => add(repo, project, postgresDb(), "alice"))).toMatchObject({
      startedBy: "alice",
    });
    await execute(
      "UPDATE projects SET removal_phase = 'deleting', removed_at = now() WHERE id = $1",
      [project],
    );
    expect(await failureOf((repo) => add(repo, project, redisCache(), "alice"))).toMatchObject({
      _tag: "ResourceDefinitionRefusedError",
    });
  });

  it("retains project resources until a complete archive, then cascades identities and instances", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
    await withRepo((repo) => repo.recordOwnDatabase(worktree, db.id, "empty"));
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`DELETE FROM projects WHERE id = ${project}`.pipe(
            Effect.as(false),
            Effect.catch(() => Effect.succeed(true)),
          ),
        ).toBe(true);
        yield* sql`INSERT INTO resource_archives(project_id, organization_id, project_name, created_by_user_id, archived_at, volumes, complete) SELECT id, organization_id, name, created_by_user_id, now(), '[]'::jsonb, true FROM projects WHERE id = ${project}`;
        yield* sql`DELETE FROM projects WHERE id = ${project}`;
        expect(
          yield* sql`SELECT resource_id FROM resource_instances WHERE resource_id = ${db.id}`,
        ).toEqual([]);
        expect(
          yield* sql`SELECT definition_id FROM resource_own_databases WHERE definition_id = ${db.id}`,
        ).toEqual([]);
      }),
    );
  });
});
