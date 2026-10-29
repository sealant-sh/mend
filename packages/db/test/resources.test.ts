import { PgClient } from "@effect/sql-pg";
import {
  ProjectId,
  ResourceDatabaseId,
  ResourceDefinitionId,
  ResourceInstanceId,
  WorktreeId,
} from "@mend/domain";
import {
  ResourceDefinitionInput,
  ResourceSpecDigest,
  resourceSpecDigest,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ResourcesRepo, ResourcesRepoLive, type SelectionChoice } from "../src/repos/resources.ts";
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
const repoLayer = ResourcesRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, ResourcesRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));
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

const decode = Schema.decodeUnknownSync(ResourceDefinitionInput);
const postgresDb = (overrides: Record<string, unknown> = {}) =>
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
  });
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

const count = (table: "resource_approvals" | "resource_selections", definition: string) =>
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

  it("declares a definition once per name, lists by name, and a repeated spec writes nothing", async () => {
    const project = await newProject();
    const first = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
    const again = await withRepo((repo) => repo.declare(project, postgresDb(), "bob"));
    expect(again).toEqual(first);

    const changed = await withRepo((repo) =>
      repo.declare(project, postgresDb({ image: "postgres:18" }), "bob"),
    );
    expect(changed).toMatchObject({ id: first.id, declaredBy: "bob" });
    expect(changed.spec.image).toBe("postgres:18");

    const listed = await withRepo((repo) => repo.listForProject(project));
    expect(listed.map((definition) => definition.spec.name)).toEqual(["cache", "db"]);
    expect(await withRepo((repo) => repo.byName(project, "db"))).toEqual(changed);
    expect(await withRepo((repo) => repo.byName(project, "queue"))).toBeNull();
  });

  it("refuses what the domain refuses, a reserved name among them, and stores nothing", async () => {
    const project = await newProject();
    expect(
      await failureOf((repo) => repo.declare(project, postgresDb({ name: "postgres" }), "alice")),
    ).toMatchObject({
      _tag: "ResourceDefinitionRefusedError",
      name: "postgres",
      refusals: [{ key: "name", message: "is reserved, because a workspace already resolves it" }],
    });
    expect(
      await failureOf((repo) => repo.declare(project, postgresDb({ ports: [] }), "alice")),
    ).toMatchObject({ _tag: "ResourceDefinitionRefusedError", refusals: [{ key: "ports" }] });
    expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
  });

  it("approves a digest once, however often it is approved, and racing approvals write one row", async () => {
    const project = await newProject();
    const definition = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    const digest = resourceSpecDigest(definition.spec);
    expect(await withRepo((repo) => repo.currentApproval(definition.id))).toBeNull();

    const approvals = await withRepo((repo) =>
      Effect.all(
        [1, 2, 3].map(() => repo.approve(definition.id, digest, "maria")),
        { concurrency: "unbounded" },
      ),
    );
    expect(new Set(approvals.map((approval) => approval.id)).size).toBe(1);
    expect(approvals[0]).toMatchObject({ revision: 1, digest, approvedBy: "maria" });
    expect(approvals[0]?.spec).toEqual(definition.spec);
    expect(await count("resource_approvals", definition.id)).toBe(1);
    expect(await withRepo((repo) => repo.currentApproval(definition.id))).toEqual(approvals[0]);
  });

  it("a changed spec has no current approval until its own digest is approved", async () => {
    const project = await newProject();
    const original = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    const first = await withRepo((repo) =>
      repo.approve(original.id, resourceSpecDigest(original.spec), "maria"),
    );
    const changed = await withRepo((repo) =>
      repo.declare(project, postgresDb({ image: "postgres:18" }), "alice"),
    );
    expect(await withRepo((repo) => repo.currentApproval(original.id))).toBeNull();

    // The approver read the old spec: approving it now would run what they did not see.
    expect(
      await failureOf((repo) =>
        repo.approve(original.id, resourceSpecDigest(original.spec), "maria"),
      ),
    ).toMatchObject({
      _tag: "ResourceApprovalStaleError",
      current: resourceSpecDigest(changed.spec),
    });
    const second = await withRepo((repo) =>
      repo.approve(original.id, resourceSpecDigest(changed.spec), "maria"),
    );
    expect(second).toMatchObject({ revision: 2, spec: changed.spec });
    expect(await withRepo((repo) => repo.currentApproval(original.id))).toEqual(second);

    // Back to the first spec: its approval stands again, since an approval is of a digest.
    await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    expect(await withRepo((repo) => repo.currentApproval(original.id))).toEqual(first);
  });

  it("answers an unknown definition with its id", async () => {
    const missing = ResourceDefinitionId.make("rdef_missing");
    expect(await failureOf((repo) => repo.currentApproval(missing))).toMatchObject({
      _tag: "ResourceDefinitionNotFoundError",
      id: missing,
    });
    expect(
      await failureOf((repo) =>
        repo.approve(missing, ResourceSpecDigest.make("0".repeat(64)), "maria"),
      ),
    ).toMatchObject({ _tag: "ResourceDefinitionNotFoundError" });
  });

  it("sets a worktree's selection from the policy's default once, and a worktree resource has none", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    const cache = await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
    const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "alice"));
    const perWorktree = await withRepo((repo) =>
      repo.declare(project, mailpit("worktree", "box"), "alice"),
    );

    const own = await withRepo((repo) => repo.ensureSelection(worktree, db.id));
    expect(own).toMatchObject({
      selection: { mode: "own", revision: 0, target: { kind: "database" } },
      chosenBy: null,
    });
    expect(await withRepo((repo) => repo.ensureSelection(worktree, db.id))).toEqual(own);
    expect(await withRepo((repo) => repo.ensureSelection(worktree, cache.id))).toMatchObject({
      selection: { mode: "shared", revision: 0 },
    });
    expect(await withRepo((repo) => repo.ensureSelection(worktree, mail.id))).toMatchObject({
      selection: { mode: "shared", revision: 0 },
    });
    expect(await withRepo((repo) => repo.ensureSelection(worktree, perWorktree.id))).toBeNull();
    expect(await count("resource_selections", perWorktree.id)).toBe(0);
  });

  it("refuses a selection the policy does not offer, or for another project's worktree, and writes nothing", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const elsewhere = await newWorktree(await newProject());
    const cache = await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
    const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    const box = await withRepo((repo) => repo.declare(project, mailpit("worktree"), "alice"));
    const instance: SelectionChoice = {
      mode: "own",
      target: { kind: "instance", instance: ResourceInstanceId.make("rins_1") },
    };

    expect(
      await failureOf((repo) => repo.setSelection(worktree, cache.id, instance, "alice")),
    ).toMatchObject({
      _tag: "ResourceSelectionRefusedError",
      refusal: { key: "mode", message: "is own, and @cache offers shared, off" },
    });
    expect(
      await failureOf((repo) => repo.setSelection(worktree, db.id, instance, "alice")),
    ).toMatchObject({ refusal: { key: "target" } });
    expect(
      await failureOf((repo) => repo.setSelection(worktree, box.id, { mode: "off" }, "alice")),
    ).toMatchObject({ refusal: { key: "selection" } });
    expect(
      await failureOf((repo) => repo.setSelection(elsewhere, db.id, { mode: "off" }, "alice")),
    ).toMatchObject({ refusal: { key: "worktree" } });
    expect(await failureOf((repo) => repo.ensureSelection(elsewhere, db.id))).toMatchObject({
      refusal: { key: "worktree" },
    });
    for (const definition of [cache, db, box])
      expect(await count("resource_selections", definition.id)).toBe(0);
  });

  it("numbers each switch as a new revision and leaves a repeated choice as it is", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    const set = (choice: SelectionChoice, by: string) =>
      withRepo((repo) => repo.setSelection(worktree, db.id, choice, by));
    const target = { kind: "database", database: ResourceDatabaseId.make("rdb_1") } as const;

    expect(await set({ mode: "shared" }, "alice")).toMatchObject({
      selection: { mode: "shared", revision: 0 },
      chosenBy: "alice",
    });
    expect(await set({ mode: "shared" }, "bob")).toMatchObject({
      selection: { mode: "shared", revision: 0 },
      chosenBy: "alice",
    });
    expect(await set({ mode: "own", target }, "bob")).toMatchObject({
      selection: { mode: "own", revision: 1, target },
      chosenBy: "bob",
    });
    const nextGeneration = {
      kind: "database",
      database: ResourceDatabaseId.make("rdb_2"),
    } as const;
    expect(await set({ mode: "own", target: nextGeneration }, "bob")).toMatchObject({
      selection: { mode: "own", revision: 2, target: nextGeneration },
    });
    expect(await set({ mode: "off" }, "bob")).toMatchObject({
      selection: { mode: "off", revision: 3 },
    });
    expect(await withRepo((repo) => repo.ensureSelection(worktree, db.id))).toMatchObject({
      selection: { mode: "off", revision: 3 },
    });
  });

  it("keeps its project until each definition is removed, and its selections go with it", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    await withRepo((repo) => repo.ensureSelection(worktree, db.id));
    const deleteProject = () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`DELETE FROM projects WHERE id = ${project}`.pipe(
            Effect.as("deleted"),
            Effect.catch(() => Effect.succeed("refused")),
          );
        }),
      );
    expect(await deleteProject()).toBe("refused");
    await withRepo((repo) => repo.remove(project, "db"));
    expect(await count("resource_selections", db.id)).toBe(0);
    expect(await deleteProject()).toBe("deleted");
  });
});
