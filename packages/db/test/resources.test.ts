import { PgClient } from "@effect/sql-pg";
import { ProjectId, ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  ResourceDefinitionInput,
  ResourceSpecDigest,
  resourceSpecDigest,
  withPresetCommand,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  type AdoptionRequest,
  type ApprovalRequest,
  ResourcesRepo,
  ResourcesRepoLive,
  type StoredResourceDefinition,
} from "../src/repos/resources.ts";
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

const execute = (statement: string, params: ReadonlyArray<unknown> = []) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe(statement, [...params]);
    }),
  );

/**
 * Runs `statement` in a transaction on its own connection, which keeps its locks until `release`
 * is called and then rolls back. `held` resolves once the statement has run.
 */
const begin = (statement: string, params: ReadonlyArray<unknown> = []) => {
  const released = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<void>();
  const done = run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(statement, [...params]);
          yield* Effect.sync(() => acquired.resolve());
          yield* Effect.promise(() => released.promise);
          return yield* Effect.fail("rolled back");
        }),
      );
    }).pipe(
      Effect.catchIf(
        (error) => error === "rolled back",
        () => Effect.void,
      ),
    ),
  );
  return {
    held: Promise.race([
      acquired.promise,
      done.then(() => {
        throw new Error("the transaction ended before its statement ran");
      }),
    ]),
    release: async () => {
      released.resolve();
      await done;
    },
  };
};

/** `begin`, once its statement holds its locks. */
const hold = async (statement: string, params: ReadonlyArray<unknown> = []) => {
  const transaction = begin(statement, params);
  await transaction.held;
  return transaction.release;
};

/** Resolves once `n` sessions on the scratch database wait on a lock, or once `unless` settles. */
const untilWaiting = async (n: number, unless?: Promise<unknown>) => {
  let settled = false;
  void unless?.finally(() => {
    settled = true;
  });
  for (let tries = 0; tries < 300; tries++) {
    if (settled) return;
    const waiting = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ readonly n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return row?.n ?? 0;
      }),
    );
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${n} sessions never waited on a lock`);
};

const imageDigest = (hex: string) => ImageDigest.make(`sha256:${hex.repeat(64)}`);
const approval = (
  definition: StoredResourceDefinition,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  definitionId: definition.id,
  digest: definition.specDigest,
  imageDigest: imageDigest("a"),
  worktreeId: null,
  approvedBy: "maria",
  ...overrides,
});
const encodeSpec = Schema.encodeSync(ResourceDefinitionInput);

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

  describe("definitions", () => {
    it("declares a definition once per name, lists by name, and a repeated spec writes nothing", async () => {
      const project = await newProject();
      const first = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      expect(first.specDigest).toBe(resourceSpecDigest(postgresDb()));
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
        refusals: [
          { key: "name", message: "is reserved, because a workspace already resolves it" },
        ],
      });
      expect(
        await failureOf((repo) => repo.declare(project, postgresDb({ ports: [] }), "alice")),
      ).toMatchObject({ _tag: "ResourceDefinitionRefusedError", refusals: [{ key: "ports" }] });
      expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
    });

    it("refuses a definition that sets an env name another one sets, keyed by its export", async () => {
      const project = await newProject();
      const db = mailpit("project", "db");
      await withRepo((repo) =>
        repo.declare(project, { ...db, exports: { MAIN_URL: "smtp://{host}" } }, "alice"),
      );
      expect(
        await failureOf((repo) =>
          repo.declare(
            project,
            { ...mailpit("project", "db-main"), exports: { URL: "smtp://{host}" } },
            "alice",
          ),
        ),
      ).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        name: "db-main",
        refusals: [
          { key: "exports.URL", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
        ],
      });
      expect(await withRepo((repo) => repo.byName(project, "db-main"))).toBeNull();
    });

    it("stores one of two colliding definitions declared at once and refuses the other", async () => {
      const project = await newProject();
      const release = await hold("SELECT 1 FROM projects WHERE id = $1 FOR NO KEY UPDATE", [
        project,
      ]);
      const declaring = [
        failureOf((repo) =>
          repo.declare(
            project,
            { ...mailpit("project", "db"), exports: { MAIN_URL: "smtp://{host}" } },
            "alice",
          ),
        ),
        failureOf((repo) =>
          repo.declare(
            project,
            { ...mailpit("project", "db-main"), exports: { URL: "smtp://{host}" } },
            "bob",
          ),
        ),
      ];
      // Both wait on the project, unless a declaration takes no lock there.
      await untilWaiting(2, Promise.all(declaring));
      await release();
      const outcomes = await Promise.all(declaring);
      expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome !== "accepted")).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [{ key: expect.stringMatching(/^exports\.(MAIN_)?URL$/) }],
      });
      expect(await withRepo((repo) => repo.listForProject(project))).toHaveLength(1);
    });
  });

  describe("the removal fence", () => {
    it("refuses a declaration once set, and lifting it lets one through", async () => {
      const project = await newProject();
      const fence = await withRepo((repo) => repo.fenceProjectRemoval(project));
      expect(await failureOf((repo) => repo.declare(project, postgresDb(), "alice"))).toMatchObject(
        {
          _tag: "ResourceDefinitionRefusedError",
          refusals: [
            { key: "project", message: "is being removed · declare it again if the removal stops" },
          ],
        },
      );
      expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
      await withRepo((repo) => repo.liftProjectRemovalFence(fence));
      expect(await failureOf((repo) => repo.declare(project, postgresDb(), "alice"))).toBe(
        "accepted",
      );
    });

    it("stands while any removal holds one: lifting one removal's fence leaves another's", async () => {
      const project = await newProject();
      const first = await withRepo((repo) => repo.fenceProjectRemoval(project));
      const second = await withRepo((repo) => repo.fenceProjectRemoval(project));
      expect(first).not.toBe(second);

      await withRepo((repo) => repo.liftProjectRemovalFence(first));
      expect(await failureOf((repo) => repo.declare(project, postgresDb(), "alice"))).toMatchObject(
        { _tag: "ResourceDefinitionRefusedError", refusals: [{ key: "project" }] },
      );
      await withRepo((repo) => repo.liftProjectRemovalFence(second));
      expect(await failureOf((repo) => repo.declare(project, postgresDb(), "alice"))).toBe(
        "accepted",
      );
    });

    it("waits for a declaration in flight and refuses removal with what it stored", async () => {
      const project = await newProject();
      const spec = postgresDb();
      // An uncommitted row of the same name holds the declaration at its insert, after it read
      // the project's definitions and found none.
      const release = await hold(
        `INSERT INTO resource_definitions
           (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
         VALUES ('rdef_held', $1, 'db', 'project', 'postgres', $2::jsonb, $3, 'held')`,
        [project, JSON.stringify(encodeSpec(spec)), resourceSpecDigest(spec)],
      );
      const declaring = failureOf((repo) => repo.declare(project, spec, "alice"));
      await untilWaiting(1);
      const fencing = failureOf((repo) => repo.fenceProjectRemoval(project));
      await untilWaiting(2);
      await release();
      expect(await declaring).toBe("accepted");
      expect(await fencing).toMatchObject({ _tag: "ProjectHasResourcesError", names: ["db"] });
      // No fence was set, so the next declaration is not refused by one.
      expect(await failureOf((repo) => repo.declare(project, redisCache(), "alice"))).toBe(
        "accepted",
      );
    });

    it("names a definition whose stored spec no longer decodes", async () => {
      const project = await newProject();
      await execute(
        `INSERT INTO resource_definitions
           (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
         VALUES ($1, $2, 'db', 'project', NULL, $3::jsonb, $4, 'alice')`,
        [
          `rdef_${crypto.randomUUID()}`,
          project,
          JSON.stringify({ name: "db", scope: "project", preset: null }),
          "0".repeat(64),
        ],
      );
      expect(await failureOf((repo) => repo.fenceProjectRemoval(project))).toMatchObject({
        _tag: "ProjectHasResourcesError",
        names: ["db"],
      });
    });

    it("goes with the project's row", async () => {
      const project = await newProject();
      await withRepo((repo) => repo.fenceProjectRemoval(project));
      await execute("DELETE FROM projects WHERE id = $1", [project]);
      const [left] = await execute(
        "SELECT count(*)::int AS n FROM project_removal_fences WHERE project_id = $1",
        [project],
      );
      expect(left).toEqual({ n: 0 });
    });
  });

  describe("approvals", () => {
    it("approves a declared spec once, pinned to its image's digest, however often it is approved", async () => {
      const project = await newProject();
      const definition = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      expect(await withRepo((repo) => repo.currentApproval(definition.id, null))).toBeNull();

      const approvals = await withRepo((repo) =>
        Effect.all(
          [1, 2, 3].map(() => repo.approve(approval(definition))),
          { concurrency: "unbounded" },
        ),
      );
      expect(new Set(approvals.map((approved) => approved.id)).size).toBe(1);
      const pinned = { ...definition.spec, image: `postgres:17@${imageDigest("a")}` };
      expect(approvals[0]).toMatchObject({
        revision: 1,
        worktreeId: null,
        definitionDigest: definition.specDigest,
        digest: resourceSpecDigest(pinned),
        spec: pinned,
        approvedBy: "maria",
      });
      expect(await count("resource_approvals", definition.id)).toBe(1);
      expect(await withRepo((repo) => repo.currentApproval(definition.id, null))).toEqual(
        approvals[0],
      );

      // The tag moved: approving what it names now is a new revision, and the current one.
      const moved = await withRepo((repo) =>
        repo.approve(approval(definition, { imageDigest: imageDigest("b") })),
      );
      expect(moved).toMatchObject({
        revision: 2,
        spec: { image: `postgres:17@${imageDigest("b")}` },
      });
      expect(await withRepo((repo) => repo.currentApproval(definition.id, null))).toEqual(moved);

      // And back: the first image is approved again as the current revision, not as the old row.
      const back = await withRepo((repo) => repo.approve(approval(definition)));
      expect(back).toMatchObject({ revision: 3, digest: resourceSpecDigest(pinned) });
      expect(await withRepo((repo) => repo.currentApproval(definition.id, null))).toEqual(back);
    });

    it("approves a tag declared again as its pinned reference, as the current approval", async () => {
      const project = await newProject();
      const tagged = await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
      const first = await withRepo((repo) => repo.approve(approval(tagged)));
      const pinned = await withRepo((repo) =>
        repo.declare(project, { ...redisCache(), image: `redis:8@${imageDigest("a")}` }, "alice"),
      );
      expect(pinned.specDigest).not.toBe(tagged.specDigest);
      expect(await withRepo((repo) => repo.currentApproval(tagged.id, null))).toBeNull();

      const again = await withRepo((repo) => repo.approve(approval(pinned)));
      expect(again).toMatchObject({
        revision: 2,
        definitionDigest: pinned.specDigest,
        digest: first.digest,
      });
      expect(await withRepo((repo) => repo.currentApproval(tagged.id, null))).toEqual(again);
      expect(await withRepo((repo) => repo.approve(approval(pinned)))).toEqual(again);
      expect(await count("resource_approvals", tagged.id)).toBe(2);
    });

    it("refuses an image that names another digest than the one it resolved to", async () => {
      const project = await newProject();
      const definition = await withRepo((repo) =>
        repo.declare(project, postgresDb({ image: `postgres:17@${imageDigest("c")}` }), "alice"),
      );
      expect(await failureOf((repo) => repo.approve(approval(definition)))).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [{ key: "image", message: `names another digest than ${imageDigest("a")}` }],
      });
      expect(
        await withRepo((repo) =>
          repo.approve(approval(definition, { imageDigest: imageDigest("c") })),
        ),
      ).toMatchObject({ spec: { image: `postgres:17@${imageDigest("c")}` } });
    });

    it("a changed spec has no current approval until it is approved itself", async () => {
      const project = await newProject();
      const original = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const first = await withRepo((repo) => repo.approve(approval(original)));
      const changed = await withRepo((repo) =>
        repo.declare(project, postgresDb({ image: "postgres:18" }), "alice"),
      );
      expect(await withRepo((repo) => repo.currentApproval(original.id, null))).toBeNull();

      // The approver read the old spec: approving it now would run what they did not see.
      expect(await failureOf((repo) => repo.approve(approval(original)))).toMatchObject({
        _tag: "ResourceApprovalStaleError",
        current: changed.specDigest,
      });
      const second = await withRepo((repo) => repo.approve(approval(changed)));
      expect(second).toMatchObject({ revision: 2, definitionDigest: changed.specDigest });
      expect(await withRepo((repo) => repo.currentApproval(original.id, null))).toEqual(second);

      // Back to the first spec: its approval stands again, since an approval is of a digest.
      await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      expect(await withRepo((repo) => repo.currentApproval(original.id, null))).toEqual(first);
    });

    it("keeps an approval when a later Mend reads the stored spec differently", async () => {
      const project = await newProject();
      const definition = await withRepo((repo) =>
        repo.declare(project, postgresDb({ limits: { cpu: 2 } }), "alice"),
      );
      const approved = await withRepo((repo) => repo.approve(approval(definition)));
      // As if the spec had been stored before `limits` existed, which now decode to the defaults.
      await execute("UPDATE resource_definitions SET spec = spec - 'limits' WHERE id = $1", [
        definition.id,
      ]);
      expect(await withRepo((repo) => repo.currentApproval(definition.id, null))).toEqual(approved);
    });

    it("refuses to approve a stored spec the rules refuse now", async () => {
      const project = await newProject();
      const spec = postgresDb({ name: "postgres" });
      const id = ResourceDefinitionId.make(`rdef_${crypto.randomUUID()}`);
      await execute(
        `INSERT INTO resource_definitions
           (id, project_id, name, scope, preset, spec, spec_digest, declared_by)
         VALUES ($1, $2, 'postgres', 'project', 'postgres', $3::jsonb, $4, 'alice')`,
        [id, project, JSON.stringify(encodeSpec(spec)), resourceSpecDigest(spec)],
      );
      const stored = await withRepo((repo) => repo.byName(project, "postgres"));
      if (stored === null) throw new Error("the inserted definition was not read");
      expect(await failureOf((repo) => repo.approve(approval(stored)))).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [{ key: "name" }],
      });
      expect(await count("resource_approvals", id)).toBe(0);
    });

    it("a change owner approves a worktree resource for their worktree alone, with an image a manager approved", async () => {
      const project = await newProject();
      const mine = await newWorktree(project);
      const theirs = await newWorktree(project);
      const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "maria"));
      const box = await withRepo((repo) =>
        repo.declare(project, mailpit("worktree", "box"), "alice"),
      );

      // No manager approved this image for the project yet.
      expect(
        await failureOf((repo) =>
          repo.approve(approval(box, { worktreeId: mine, approvedBy: "alice" })),
        ),
      ).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [
          {
            key: "image",
            message: `is ${imageDigest("a")}, which no manager approved for this project`,
          },
        ],
      });
      await withRepo((repo) => repo.approve(approval(mail)));
      const forMine = await withRepo((repo) =>
        repo.approve(approval(box, { worktreeId: mine, approvedBy: "alice" })),
      );
      expect(forMine).toMatchObject({ worktreeId: mine, approvedBy: "alice" });
      expect(
        await withRepo((repo) =>
          repo.approve(approval(box, { worktreeId: mine, approvedBy: "alice" })),
        ),
      ).toEqual(forMine);

      expect(await withRepo((repo) => repo.currentApproval(box.id, mine))).toEqual(forMine);
      expect(await withRepo((repo) => repo.currentApproval(box.id, theirs))).toBeNull();
      expect(await withRepo((repo) => repo.currentApproval(box.id, null))).toBeNull();

      // A manager's approval for the project holds in every worktree.
      const forProject = await withRepo((repo) => repo.approve(approval(box)));
      expect(await withRepo((repo) => repo.currentApproval(box.id, theirs))).toEqual(forProject);
    });

    it("lists each definition with the approval of the spec it holds, for the project or the worktree read", async () => {
      const project = await newProject();
      const mine = await newWorktree(project);
      const theirs = await newWorktree(project);
      const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "maria"));
      const box = await withRepo((repo) =>
        repo.declare(project, mailpit("worktree", "box"), "alice"),
      );
      await withRepo((repo) => repo.approve(approval(mail)));
      const forMine = await withRepo((repo) =>
        repo.approve(approval(box, { worktreeId: mine, approvedBy: "alice" })),
      );
      const approvals = (worktree: WorktreeId | null) =>
        withRepo((repo) => repo.listWithApprovals(project, worktree)).then((listed) =>
          listed.map((each) => [each.definition.spec.name, each.approval?.id ?? null]),
        );
      expect(await approvals(mine)).toEqual([
        ["box", forMine.id],
        ["mail", expect.any(String)],
      ]);
      expect(await approvals(theirs)).toEqual([
        ["box", null],
        ["mail", expect.any(String)],
      ]);
      expect(await approvals(null)).toEqual([
        ["box", null],
        ["mail", expect.any(String)],
      ]);

      // Declared again with another spec, the listed spec has no approval of its own.
      await withRepo((repo) =>
        repo.declare(project, { ...mailpit("project"), image: "axllent/mailpit:v1.28" }, "maria"),
      );
      expect(await approvals(null)).toEqual([
        ["box", null],
        ["mail", null],
      ]);
    });

    it("refuses a worktree approval of a project resource, or for another project's worktree", async () => {
      const project = await newProject();
      const elsewhere = await newWorktree(await newProject());
      const worktree = await newWorktree(project);
      const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "maria"));
      const box = await withRepo((repo) =>
        repo.declare(project, mailpit("worktree", "box"), "alice"),
      );
      await withRepo((repo) => repo.approve(approval(mail)));
      expect(
        await failureOf((repo) => repo.approve(approval(mail, { worktreeId: worktree }))),
      ).toMatchObject({ refusals: [{ key: "worktree" }] });
      expect(
        await failureOf((repo) => repo.approve(approval(box, { worktreeId: elsewhere }))),
      ).toMatchObject({
        refusals: [
          { key: "worktree", message: "is not a worktree of the project that declares @box" },
        ],
      });
      expect(await count("resource_approvals", box.id)).toBe(0);
    });

    it("answers an unknown definition with its id", async () => {
      const missing = ResourceDefinitionId.make("rdef_missing");
      expect(await failureOf((repo) => repo.currentApproval(missing, null))).toMatchObject({
        _tag: "ResourceDefinitionNotFoundError",
        id: missing,
      });
      expect(
        await failureOf((repo) =>
          repo.approve({
            definitionId: missing,
            digest: ResourceSpecDigest.make("0".repeat(64)),
            imageDigest: imageDigest("a"),
            worktreeId: null,
            approvedBy: "maria",
          }),
        ),
      ).toMatchObject({ _tag: "ResourceDefinitionNotFoundError" });
    });
  });

  describe("selections", () => {
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

      expect(
        await failureOf((repo) => repo.setSelection(worktree, cache.id, { mode: "own" }, "alice")),
      ).toMatchObject({
        _tag: "ResourceSelectionRefusedError",
        definitionId: cache.id,
        refusal: { key: "mode", message: "is own, and @cache offers shared, off" },
      });
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

    it("numbers each switch as a new revision, and a repeated choice keeps it but records who chose", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const cache = await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
      const set = (mode: "off" | "shared" | "own", by: string) =>
        withRepo((repo) => repo.setSelection(worktree, db.id, { mode }, by));

      // The default, chosen explicitly, is the person's choice from then on.
      await withRepo((repo) => repo.ensureSelection(worktree, cache.id));
      expect(
        await withRepo((repo) =>
          repo.setSelection(worktree, cache.id, { mode: "shared" }, "alice"),
        ),
      ).toMatchObject({ selection: { mode: "shared", revision: 0 }, chosenBy: "alice" });

      expect(await set("shared", "alice")).toMatchObject({
        selection: { mode: "shared", revision: 0 },
        chosenBy: "alice",
      });
      expect(await set("shared", "bob")).toMatchObject({
        selection: { mode: "shared", revision: 0 },
        chosenBy: "alice",
      });
      const own = await set("own", "bob");
      expect(own).toMatchObject({
        selection: { mode: "own", revision: 1, target: { kind: "database" } },
        chosenBy: "bob",
      });
      expect(await set("own", "alice")).toEqual(own);
      expect(await set("off", "bob")).toMatchObject({ selection: { mode: "off", revision: 2 } });
      expect(await withRepo((repo) => repo.ensureSelection(worktree, db.id))).toMatchObject({
        selection: { mode: "off", revision: 2 },
      });
    });

    it("mints each own target, so no two worktrees share one", async () => {
      const project = await newProject();
      const [one, two] = [await newWorktree(project), await newWorktree(project)];
      const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "alice"));
      const owned = await withRepo((repo) =>
        Effect.all(
          [one, two].flatMap((worktree) => [
            repo.setSelection(worktree, db.id, { mode: "own" }, "alice"),
            repo.setSelection(worktree, mail.id, { mode: "own" }, "alice"),
          ]),
        ),
      );
      expect(owned.map((stored) => stored.selection)).toMatchObject([
        { target: { kind: "database" } },
        { target: { kind: "instance" } },
        { target: { kind: "database" } },
        { target: { kind: "instance" } },
      ]);
      const targets = owned.map((stored) => JSON.stringify(stored.selection));
      expect(new Set(targets).size).toBe(4);
    });

    it("a switch returns the choice it wrote, though another switch commits before it could read", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const cache = await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
      await withRepo((repo) => repo.setSelection(worktree, cache.id, { mode: "shared" }, "alice"));
      // The selection's row lock holds both switches, the first one in line first.
      const release = await hold(
        "SELECT 1 FROM resource_selections WHERE worktree_id = $1 FOR UPDATE",
        [worktree],
      );
      const first = withRepo((repo) =>
        repo.setSelection(worktree, cache.id, { mode: "off" }, "alice"),
      );
      await untilWaiting(1);
      const second = withRepo((repo) =>
        repo.setSelection(worktree, cache.id, { mode: "shared" }, "bob"),
      );
      await untilWaiting(2);
      // A table lock queued behind both makes any later read of the table wait until the second
      // switch has committed.
      const barrier = begin("LOCK TABLE resource_selections IN ACCESS EXCLUSIVE MODE");
      await untilWaiting(3);
      await release();
      await barrier.held;
      await barrier.release();
      expect(await first).toMatchObject({
        selection: { mode: "off", revision: 1 },
        chosenBy: "alice",
      });
      expect(await second).toMatchObject({
        selection: { mode: "shared", revision: 2 },
        chosenBy: "bob",
      });
    });

    it("re-defaults a stored selection the policy refuses now, under a new revision", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const cache = await withRepo((repo) => repo.declare(project, redisCache(), "alice"));
      await withRepo((repo) => repo.setSelection(worktree, cache.id, { mode: "off" }, "alice"));
      // As a Mend whose policy offered Redis an own instance would have stored it.
      await execute(
        `UPDATE resource_selections SET mode = 'own', revision = 4,
           own_target = '{"kind":"instance","instance":"rins_old"}'::jsonb
         WHERE worktree_id = $1`,
        [worktree],
      );
      expect(await withRepo((repo) => repo.ensureSelection(worktree, cache.id))).toMatchObject({
        selection: { mode: "shared", revision: 5 },
        chosenBy: null,
      });
      await execute(
        `UPDATE resource_selections SET mode = 'own', revision = 6,
           own_target = '{"kind":"instance","instance":"rins_old"}'::jsonb
         WHERE worktree_id = $1`,
        [worktree],
      );
      expect(
        await withRepo((repo) => repo.setSelection(worktree, cache.id, { mode: "off" }, "bob")),
      ).toMatchObject({ selection: { mode: "off", revision: 7 }, chosenBy: "bob" });
    });
  });

  describe("a declaration that changes the policy", () => {
    it("is refused while a worktree holds the resource as own, and changes nothing", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const own = await withRepo((repo) => repo.ensureSelection(worktree, db.id));
      const asRedis = postgresDb({
        preset: "redis",
        image: "redis:8",
        ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
        volumes: [{ name: "data", mountPath: "/data" }],
      });
      expect(await failureOf((repo) => repo.declare(project, asRedis, "alice"))).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [
          {
            key: "preset",
            message:
              "changes what own is, and 1 worktree holds @db as own, with data of its own · switch it to shared or off first",
          },
        ],
      });
      expect(await withRepo((repo) => repo.byName(project, "db"))).toEqual(db);
      expect(await withRepo((repo) => repo.ensureSelection(worktree, db.id))).toEqual(own);
    });

    it("re-defaults every other selection to the new policy's default, each under a new revision", async () => {
      const project = await newProject();
      const [one, two] = [await newWorktree(project), await newWorktree(project)];
      const mail = await withRepo((repo) =>
        repo.declare(project, mailpit("project", "db"), "alice"),
      );
      await withRepo((repo) => repo.setSelection(one, mail.id, { mode: "off" }, "alice"));
      await withRepo((repo) => repo.ensureSelection(two, mail.id));
      await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const selections = await withRepo((repo) =>
        Effect.all([one, two].map((worktree) => repo.ensureSelection(worktree, mail.id))),
      );
      expect(selections).toMatchObject([
        { selection: { mode: "own", revision: 1, target: { kind: "database" } }, chosenBy: null },
        { selection: { mode: "own", revision: 1, target: { kind: "database" } }, chosenBy: null },
      ]);
    });

    it("to worktree scope removes the selections, since a worktree resource has none", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "alice"));
      await withRepo((repo) => repo.setSelection(worktree, mail.id, { mode: "off" }, "alice"));
      await withRepo((repo) => repo.declare(project, mailpit("worktree"), "alice"));
      expect(await count("resource_selections", mail.id)).toBe(0);
      expect(await withRepo((repo) => repo.ensureSelection(worktree, mail.id))).toBeNull();
    });

    it("waits for a selection being written, and does not leave it behind", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const mail = await withRepo((repo) => repo.declare(project, mailpit("project"), "alice"));
      // The worktree's row lock holds the selection at its insert, after it checked the policy.
      const release = await hold("SELECT 1 FROM worktrees WHERE id = $1 FOR UPDATE", [worktree]);
      const selecting = failureOf((repo) =>
        repo.setSelection(worktree, mail.id, { mode: "shared" }, "alice"),
      );
      await untilWaiting(1);
      const declaring = failureOf((repo) => repo.declare(project, mailpit("worktree"), "alice"));
      await untilWaiting(2, declaring);
      await release();
      expect(await selecting).toBe("accepted");
      expect(await declaring).toBe("accepted");
      expect(await count("resource_selections", mail.id)).toBe(0);
    });
  });

  it("keeps its project until each definition is removed, and its approvals and selections go with it", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
    await withRepo((repo) => repo.ensureSelection(worktree, db.id));
    await withRepo((repo) => repo.approve(approval(db)));
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
    await withRepo((repo) => repo.removeIfCurrent(project, { id: db.id, digest: db.specDigest }));
    expect(await count("resource_selections", db.id)).toBe(0);
    expect(await count("resource_approvals", db.id)).toBe(0);
    expect(await deleteProject()).toBe("deleted");
  });

  describe("proposals beside the project's definitions", () => {
    it("keeps two members' proposals of one name, apart from settings, across a restart", async () => {
      const project = await newProject();
      const maria = await withRepo((repo) => repo.propose(project, postgresDb(), "maria"));
      const tom = await withRepo((repo) =>
        repo.propose(project, postgresDb({ image: "postgres:18" }), "tom"),
      );
      expect(maria.id).not.toBe(tom.id);

      // Each run opens its own pool, as a restarted Mend does.
      const after = await withRepo((repo) => repo.proposals(project));
      expect(after.map((proposal) => [proposal.proposedBy, proposal.spec.image])).toEqual([
        ["maria", "postgres:17"],
        ["tom", "postgres:18"],
      ]);
      expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
      expect(await withRepo((repo) => repo.byName(project, "db"))).toBeNull();
    });

    it("keeps one row when an author proposes the same spec again", async () => {
      const project = await newProject();
      const first = await withRepo((repo) => repo.propose(project, postgresDb(), "maria"));
      const again = await withRepo((repo) => repo.propose(project, postgresDb(), "maria"));
      expect(again.id).toBe(first.id);
      expect(await withRepo((repo) => repo.proposals(project))).toHaveLength(1);
    });

    it("answers a repeated proposal with its row though a withdrawal commits while it is stored", async () => {
      const project = await newProject();
      const first = await withRepo((repo) => repo.propose(project, postgresDb(), "maria"));
      // Holds every later insert's statement open after it met the author's row, until released.
      await execute(`CREATE FUNCTION hold_proposal_insert() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN PERFORM pg_advisory_xact_lock(4101); RETURN NULL; END $$`);
      await execute(`CREATE TRIGGER hold_proposal_insert AFTER INSERT ON resource_proposals
        FOR EACH STATEMENT EXECUTE FUNCTION hold_proposal_insert()`);
      try {
        const release = await hold("SELECT pg_advisory_xact_lock(4101)");
        const proposing = failureOf((repo) => repo.propose(project, postgresDb(), "maria"));
        await untilWaiting(1, proposing);
        const withdrawing = withRepo((repo) => repo.withdrawProposal(project, first.id));
        await untilWaiting(2, withdrawing);
        await release();
        expect(await proposing).toBe("accepted");
        expect(await withdrawing).toBe(true);
        expect(await withRepo((repo) => repo.proposals(project))).toEqual([]);
      } finally {
        await execute("DROP TRIGGER hold_proposal_insert ON resource_proposals");
        await execute("DROP FUNCTION hold_proposal_insert()");
      }
    });

    it("refuses a proposal the definition rules refuse, keyed by field", async () => {
      const project = await newProject();
      const refused = await failureOf((repo) =>
        repo.propose(project, postgresDb({ ports: [] }), "maria"),
      );
      expect(refused).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [{ key: "ports" }],
      });
    });

    it("withdraws a proposal once, in its own project only", async () => {
      const project = await newProject();
      const other = await newProject();
      const proposal = await withRepo((repo) => repo.propose(project, postgresDb(), "maria"));
      expect(await withRepo((repo) => repo.withdrawProposal(other, proposal.id))).toBe(false);
      expect(await withRepo((repo) => repo.withdrawProposal(project, proposal.id))).toBe(true);
      expect(await withRepo((repo) => repo.withdrawProposal(project, proposal.id))).toBe(false);
    });

    it("goes with its project", async () => {
      const project = await newProject();
      await withRepo((repo) => repo.propose(project, postgresDb(), "maria"));
      await execute("DELETE FROM projects WHERE id = $1", [project]);
      expect(await withRepo((repo) => repo.proposals(project))).toEqual([]);
    });
  });

  describe("removing a definition as its remover read it", () => {
    it("removes it while it holds the spec read, and refuses once it changed", async () => {
      const project = await newProject();
      const read = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const changed = await withRepo((repo) =>
        repo.declare(project, postgresDb({ image: "postgres:18" }), "alice"),
      );
      expect(
        await failureOf((repo) =>
          repo.removeIfCurrent(project, { id: read.id, digest: read.specDigest }),
        ),
      ).toMatchObject({ _tag: "ResourceDefinitionStaleError", current: changed.specDigest });
      expect(await withRepo((repo) => repo.byName(project, "db"))).not.toBeNull();

      await withRepo((repo) =>
        repo.removeIfCurrent(project, { id: changed.id, digest: changed.specDigest }),
      );
      expect(await withRepo((repo) => repo.byName(project, "db"))).toBeNull();
    });

    it("does not reach another project's definition", async () => {
      const project = await newProject();
      const other = await newProject();
      const db = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      expect(
        await failureOf((repo) =>
          repo.removeIfCurrent(other, { id: db.id, digest: db.specDigest }),
        ),
      ).toMatchObject({ _tag: "ResourceDefinitionNotFoundError" });
    });
  });

  describe("adopting a definition and approving it at once", () => {
    const adoption = (
      projectId: ProjectId,
      spec: ResourceDefinitionInput,
      overrides: Partial<AdoptionRequest> = {},
    ): AdoptionRequest => ({
      projectId,
      spec,
      settings: null,
      imageDigest: imageDigest("a"),
      worktreeId: null,
      approvedBy: "maria",
      ...overrides,
    });

    it("declares and approves an absent definition in one write, and twice is one approval", async () => {
      const project = await newProject();
      const first = await withRepo((repo) => repo.adoptAndApprove(adoption(project, postgresDb())));
      expect(first.definition.spec).toEqual(postgresDb());
      expect(first.approval.spec.image).toBe(`postgres:17@${imageDigest("a")}`);

      // A retry, after the tag moved: the approval made is the answer, and nothing repins.
      const again = await withRepo((repo) =>
        repo.adoptAndApprove(adoption(project, postgresDb(), { imageDigest: imageDigest("b") })),
      );
      expect(again.approval.id).toBe(first.approval.id);
      expect([first.made, again.made]).toEqual([true, false]);
      expect(await count("resource_approvals", first.definition.id)).toBe(1);
      expect(
        await withRepo((repo) =>
          repo.approvalAsRead({
            projectId: project,
            spec: postgresDb(),
            settings: { id: first.definition.id, digest: first.definition.specDigest },
            worktreeId: null,
          }),
        ),
      ).toMatchObject({ approval: { id: first.approval.id } });
    });

    it("refuses a read settings have moved on from, and writes nothing", async () => {
      const project = await newProject();
      const read = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      const changed = await withRepo((repo) =>
        repo.declare(project, postgresDb({ image: "postgres:17.6" }), "alice"),
      );
      const proposal = postgresDb({ image: "postgres:18" });
      expect(
        await failureOf((repo) =>
          repo.adoptAndApprove(
            adoption(project, proposal, { settings: { id: read.id, digest: read.specDigest } }),
          ),
        ),
      ).toEqual(expect.objectContaining({ _tag: "ResourceSettingsStaleError", name: "db" }));
      // A read of no definition, where one now is.
      expect(
        await failureOf((repo) => repo.adoptAndApprove(adoption(project, proposal))),
      ).toMatchObject({ _tag: "ResourceSettingsStaleError" });
      expect(await withRepo((repo) => repo.byName(project, "db"))).toMatchObject({
        specDigest: changed.specDigest,
      });
      expect(await count("resource_approvals", changed.id)).toBe(0);

      const adopted = await withRepo((repo) =>
        repo.adoptAndApprove(
          adoption(project, proposal, { settings: { id: changed.id, digest: changed.specDigest } }),
        ),
      );
      expect(adopted.definition.id).toBe(changed.id);
      expect(adopted.definition.spec.image).toBe("postgres:18");
    });

    it("refuses a read of a definition removed and declared again with the same spec", async () => {
      const project = await newProject();
      const read = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      await withRepo((repo) =>
        repo.removeIfCurrent(project, { id: read.id, digest: read.specDigest }),
      );
      const again = await withRepo((repo) => repo.declare(project, postgresDb(), "alice"));
      expect(
        await failureOf((repo) =>
          repo.adoptAndApprove(
            adoption(project, postgresDb(), {
              settings: { id: read.id, digest: read.specDigest },
            }),
          ),
        ),
      ).toEqual(expect.objectContaining({ _tag: "ResourceSettingsStaleError", name: "db" }));
      expect(await count("resource_approvals", again.id)).toBe(0);
    });

    it("answers an approval already made only while settings hold what was read", async () => {
      const project = await newProject();
      const elsewhere = await newProject();
      const read = await withRepo((repo) => repo.adoptAndApprove(adoption(project, postgresDb())));
      const foreign = await withRepo((repo) =>
        repo.adoptAndApprove(adoption(elsewhere, postgresDb())),
      );
      const lookup = (settings: { id: ResourceDefinitionId; digest: ResourceSpecDigest }) =>
        failureOf((repo) =>
          repo.approvalAsRead({
            projectId: project,
            spec: postgresDb(),
            settings,
            worktreeId: null,
          }),
        );
      // Another project's definition, named by its id, answers nothing of it.
      expect(
        await lookup({ id: foreign.definition.id, digest: foreign.definition.specDigest }),
      ).toEqual(expect.objectContaining({ _tag: "ResourceSettingsStaleError", name: "db" }));

      // Declared again with another spec: the approval made of the spec read is history.
      await withRepo((repo) =>
        repo.declare(project, postgresDb({ image: "postgres:17.6" }), "alice"),
      );
      expect(await lookup({ id: read.definition.id, digest: read.definition.specDigest })).toEqual(
        expect.objectContaining({ _tag: "ResourceSettingsStaleError", name: "db" }),
      );
    });

    it("leaves settings as they were when the approval is refused", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      // No manager approved this image for the project (decision G4).
      expect(
        await failureOf((repo) =>
          repo.adoptAndApprove(adoption(project, mailpit("worktree"), { worktreeId: worktree })),
        ),
      ).toMatchObject({ _tag: "ResourceDefinitionRefusedError" });
      expect(await withRepo((repo) => repo.byName(project, "mail"))).toBeNull();
    });

    it("approves a worktree resource for one worktree once a manager approved its image", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      await withRepo((repo) =>
        repo.adoptAndApprove(adoption(project, mailpit("project", "mailer"))),
      );
      const mine = await withRepo((repo) =>
        repo.adoptAndApprove(
          adoption(project, mailpit("worktree"), { worktreeId: worktree, approvedBy: "tom" }),
        ),
      );
      expect(mine.approval).toMatchObject({ worktreeId: worktree, approvedBy: "tom" });
      expect(
        await withRepo((repo) =>
          repo.approvalAsRead({
            projectId: project,
            spec: mailpit("worktree"),
            settings: null,
            worktreeId: null,
          }),
        ),
      ).toBeNull();
    });
  });
});
