import { PgClient } from "@effect/sql-pg";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  ResourceDefinitionInput,
  resourceSpecDigest,
  withPresetCommand,
} from "@mend/domain/workbench";
import { Effect, Layer, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** How long migration 0166 keeps a removal's mark fresh without renewal. */
const MIGRATION_0166_LEASE_SECONDS = 120;

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ResourcesRepo, ResourcesRepoLive } from "../src/repos/resources.ts";
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
/** `repo.declare` of `spec`, its image resolved to `imageDigest(hex)`. */
const add = (
  repo: ResourcesRepo["Service"],
  project: ProjectId,
  spec: ResourceDefinitionInput,
  addedBy: string,
  hex = "a",
) => repo.declare(project, { spec, imageDigest: imageDigest(hex) }, addedBy);
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
      const first = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      expect(first.specDigest).toBe(resourceSpecDigest(postgresDb()));
      await withRepo((repo) => add(repo, project, redisCache(), "alice"));
      const again = await withRepo((repo) => add(repo, project, postgresDb(), "bob"));
      expect(again).toEqual(first);

      const changed = await withRepo((repo) =>
        add(repo, project, postgresDb({ image: "postgres:18" }), "bob"),
      );
      expect(changed).toMatchObject({ id: first.id, addedBy: "bob" });
      expect(changed.spec.image).toBe("postgres:18");

      const listed = await withRepo((repo) => repo.listForProject(project));
      expect(listed.map((definition) => definition.spec.name)).toEqual(["cache", "db"]);
      expect(await withRepo((repo) => repo.byName(project, "db"))).toEqual(changed);
      expect(await withRepo((repo) => repo.byName(project, "queue"))).toBeNull();
    });

    it("refuses what the domain refuses, a reserved name among them, and stores nothing", async () => {
      const project = await newProject();
      expect(
        await failureOf((repo) => add(repo, project, postgresDb({ name: "postgres" }), "alice")),
      ).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        name: "postgres",
        refusals: [
          { key: "name", message: "is reserved, because a workspace already resolves it" },
        ],
      });
      expect(
        await failureOf((repo) => add(repo, project, postgresDb({ ports: [] }), "alice")),
      ).toMatchObject({ _tag: "ResourceDefinitionRefusedError", refusals: [{ key: "ports" }] });
      expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
    });

    it("refuses a definition that sets an env name another one sets, keyed by its export", async () => {
      const project = await newProject();
      const db = mailpit("project", "db");
      await withRepo((repo) =>
        add(repo, project, { ...db, exports: { MAIN_URL: "smtp://{host}" } }, "alice"),
      );
      expect(
        await failureOf((repo) =>
          add(
            repo,
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
          add(
            repo,
            project,
            { ...mailpit("project", "db"), exports: { MAIN_URL: "smtp://{host}" } },
            "alice",
          ),
        ),
        failureOf((repo) =>
          add(
            repo,
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

  describe("a project removal's mark", () => {
    const mark = (project: string, phase: "checking" | "deleting", secondsAgo = 0) =>
      execute(
        `UPDATE projects SET removal_phase = $2, removal_id = 'rmv_test',
           removal_since = now() - make_interval(secs => $3),
           removed_at = CASE WHEN $2 = 'deleting' THEN now() END WHERE id = $1`,
        [project, phase, secondsAgo],
      );

    it("refuses a declaration while it stands, and lets one through once it is lifted", async () => {
      const project = await newProject();
      await mark(project, "checking");
      expect(await failureOf((repo) => add(repo, project, postgresDb(), "alice"))).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [
          { key: "project", message: "is being removed · declare it again if the removal stops" },
        ],
      });
      expect(await withRepo((repo) => repo.listForProject(project))).toEqual([]);
      await execute(
        "UPDATE projects SET removal_phase = NULL, removal_id = NULL, removal_since = NULL WHERE id = $1",
        [project],
      );
      expect(await failureOf((repo) => add(repo, project, postgresDb(), "alice"))).toBe("accepted");
    });

    it("refuses nothing once a removal that stopped while checking lets it lapse", async () => {
      const project = await newProject();
      await mark(project, "checking", MIGRATION_0166_LEASE_SECONDS + 5);
      expect(await failureOf((repo) => add(repo, project, postgresDb(), "alice"))).toBe("accepted");
    });

    it("keeps refusing while a purge that stopped still has to delete", async () => {
      const project = await newProject();
      await mark(project, "deleting", MIGRATION_0166_LEASE_SECONDS + 5);
      expect(await failureOf((repo) => add(repo, project, postgresDb(), "alice"))).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [{ key: "project" }],
      });
    });

    it("makes a removal that marks during a declaration see what it stored", async () => {
      const project = await newProject();
      const spec = postgresDb();
      // An uncommitted row of the same name holds the declaration at its insert, after it read
      // the project's definitions and found none.
      const release = await hold(
        `INSERT INTO resource_definitions
           (id, project_id, name, scope, preset, spec, spec_digest, image_digest, added_by)
         VALUES ('rdef_held', $1, 'db', 'project', 'postgres', $2::jsonb, $3, $4, 'held')`,
        [project, JSON.stringify(encodeSpec(spec)), resourceSpecDigest(spec), imageDigest("a")],
      );
      const declaring = failureOf((repo) => add(repo, project, spec, "alice"));
      await untilWaiting(1);
      const marking = execute(
        `UPDATE projects SET removal_phase = 'checking', removal_id = 'rmv_test',
           removal_since = now() WHERE id = $1`,
        [project],
      );
      await untilWaiting(2);
      await release();
      expect(await declaring).toBe("accepted");
      await marking;
      expect(await withRepo((repo) => repo.declaredNames(project))).toEqual(["db"]);
    });

    it("names a definition whose stored spec no longer decodes", async () => {
      const project = await newProject();
      await execute(
        `INSERT INTO resource_definitions
           (id, project_id, name, scope, preset, spec, spec_digest, image_digest, added_by)
         VALUES ($1, $2, 'db', 'project', NULL, $3::jsonb, $4, $5, 'alice')`,
        [
          `rdef_${crypto.randomUUID()}`,
          project,
          JSON.stringify({ name: "db", scope: "project", preset: null }),
          "0".repeat(64),
          imageDigest("a"),
        ],
      );
      expect(await withRepo((repo) => repo.declaredNames(project))).toEqual(["db"]);
    });
  });

  describe("pinning the image when a definition is added", () => {
    it("keeps the digest the image resolved to, and runs the image pinned to it", async () => {
      const project = await newProject();
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      expect(db).toMatchObject({
        spec: { image: "postgres:17" },
        imageDigest: imageDigest("a"),
        image: `postgres:17@${imageDigest("a")}`,
      });
      expect(await withRepo((repo) => repo.byName(project, "db"))).toEqual(db);
    });

    it("repins the same spec when its tag resolved elsewhere, as whoever added it again", async () => {
      const project = await newProject();
      const first = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      const moved = await withRepo((repo) => add(repo, project, postgresDb(), "bob", "b"));
      expect(moved).toMatchObject({
        id: first.id,
        specDigest: first.specDigest,
        image: `postgres:17@${imageDigest("b")}`,
        addedBy: "bob",
      });
    });

    it("keeps an image already pinned, and refuses a pin that names another digest", async () => {
      const project = await newProject();
      const pinned = `redis:8@${imageDigest("c")}`;
      const cache = await withRepo((repo) =>
        add(repo, project, { ...redisCache(), image: pinned }, "alice", "c"),
      );
      expect(cache.image).toBe(pinned);
      expect(
        await failureOf((repo) =>
          add(repo, project, { ...redisCache(), image: pinned }, "bob", "d"),
        ),
      ).toMatchObject({
        _tag: "ResourceDefinitionRefusedError",
        refusals: [{ key: "image", message: `names another digest than ${imageDigest("d")}` }],
      });
      expect(await withRepo((repo) => repo.byName(project, "cache"))).toEqual(cache);
    });

    it("lists each definition with the read worktree's stored choice, and none without one", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      const cache = await withRepo((repo) => add(repo, project, redisCache(), "alice"));
      await withRepo((repo) => repo.setSelection(project, worktree, db.id, "own", "alice"));
      expect(await withRepo((repo) => repo.listWithChoices(project, worktree))).toEqual([
        { definition: cache, choice: null },
        { definition: db, choice: "own" },
      ]);
      expect(await withRepo((repo) => repo.listWithChoices(project, null))).toEqual([
        { definition: cache, choice: null },
        { definition: db, choice: null },
      ]);
    });
  });

  describe("selections", () => {
    it("refuses a selection the policy does not offer, or for another project's worktree, and writes nothing", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const other = await newProject();
      const elsewhere = await newWorktree(other);
      const cache = await withRepo((repo) => add(repo, project, redisCache(), "alice"));
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      const box = await withRepo((repo) => add(repo, project, mailpit("worktree"), "alice"));

      expect(
        await failureOf((repo) => repo.setSelection(project, worktree, cache.id, "own", "alice")),
      ).toMatchObject({
        _tag: "ResourceSelectionRefusedError",
        definitionId: cache.id,
        refusal: { key: "mode", message: "is own, and @cache offers shared, off" },
      });
      expect(
        await failureOf((repo) => repo.setSelection(project, worktree, box.id, "off", "alice")),
      ).toMatchObject({ refusal: { key: "selection" } });
      expect(
        await failureOf((repo) => repo.setSelection(project, elsewhere, db.id, "off", "alice")),
      ).toMatchObject({ refusal: { key: "worktree" } });
      // From the other project, this project's definition is not found, and its name is not said.
      expect(
        await failureOf((repo) => repo.setSelection(other, elsewhere, db.id, "off", "alice")),
      ).toEqual(expect.objectContaining({ _tag: "ResourceDefinitionNotFoundError", id: db.id }));
      for (const definition of [cache, db, box])
        expect(await count("resource_selections", definition.id)).toBe(0);
    });

    it("stores the mode alone, and a repeated choice keeps who chose it", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      const set = (mode: "off" | "shared" | "own", by: string) =>
        withRepo((repo) => repo.setSelection(project, worktree, db.id, mode, by));

      expect(await set("shared", "alice")).toMatchObject({ mode: "shared", chosenBy: "alice" });
      expect(await set("shared", "bob")).toMatchObject({ mode: "shared", chosenBy: "alice" });
      expect(await set("own", "bob")).toMatchObject({ mode: "own", chosenBy: "bob" });
      expect(await set("off", "alice")).toMatchObject({ mode: "off", chosenBy: "alice" });
      expect(await withRepo((repo) => repo.listWithChoices(project, worktree))).toEqual([
        { definition: db, choice: "off" },
      ]);
    });
  });

  describe("own databases", () => {
    it("records how each began, as it was last made, and only for its worktree", async () => {
      const project = await newProject();
      const [one, two] = [await newWorktree(project), await newWorktree(project)];
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      await withRepo((repo) => repo.recordOwnDatabase(one, db.id, "copied"));
      expect([...(await withRepo((repo) => repo.ownDatabases(one)))]).toEqual([
        [db.id, { kind: "copied", at: expect.any(Date) }],
      ]);
      // A reset makes it again.
      await withRepo((repo) => repo.recordOwnDatabase(one, db.id, "empty"));
      const mine = await withRepo((repo) => repo.ownDatabases(one));
      expect([...mine]).toEqual([[db.id, { kind: "empty", at: expect.any(Date) }]]);
      expect((await withRepo((repo) => repo.ownDatabases(two))).size).toBe(0);
    });

    it("goes with its definition", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      await withRepo((repo) => repo.recordOwnDatabase(worktree, db.id, "empty"));
      await withRepo((repo) => repo.removeIfCurrent(project, { id: db.id, digest: db.specDigest }));
      expect((await withRepo((repo) => repo.ownDatabases(worktree))).size).toBe(0);
    });
  });

  describe("a declaration that changes the policy", () => {
    it("is refused while a worktree holds the resource as own, and changes nothing", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      await withRepo((repo) => repo.setSelection(project, worktree, db.id, "own", "alice"));
      const asRedis = postgresDb({
        preset: "redis",
        image: "redis:8",
        ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
        volumes: [{ name: "data", mountPath: "/data" }],
      });
      expect(await failureOf((repo) => add(repo, project, asRedis, "alice"))).toMatchObject({
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
      expect(await withRepo((repo) => repo.listWithChoices(project, worktree))).toEqual([
        { definition: db, choice: "own" },
      ]);
    });

    it("drops every other worktree's choice, so each takes the new policy's default", async () => {
      const project = await newProject();
      const [one, two] = [await newWorktree(project), await newWorktree(project)];
      const mail = await withRepo((repo) => add(repo, project, mailpit("project", "db"), "alice"));
      await withRepo((repo) => repo.setSelection(project, one, mail.id, "off", "alice"));
      await withRepo((repo) => repo.setSelection(project, two, mail.id, "shared", "alice"));
      await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      expect(await count("resource_selections", mail.id)).toBe(0);
    });

    it("waits for a selection being written, and does not leave it behind", async () => {
      const project = await newProject();
      const worktree = await newWorktree(project);
      const mail = await withRepo((repo) => add(repo, project, mailpit("project"), "alice"));
      // The worktree's row lock holds the selection at its insert, after it checked the policy.
      const release = await hold("SELECT 1 FROM worktrees WHERE id = $1 FOR UPDATE", [worktree]);
      const selecting = failureOf((repo) =>
        repo.setSelection(project, worktree, mail.id, "shared", "alice"),
      );
      await untilWaiting(1);
      const declaring = failureOf((repo) => add(repo, project, mailpit("worktree"), "alice"));
      await untilWaiting(2, declaring);
      await release();
      expect(await selecting).toBe("accepted");
      expect(await declaring).toBe("accepted");
      expect(await count("resource_selections", mail.id)).toBe(0);
    });
  });

  it("keeps its project until each definition is removed, and its selections go with it", async () => {
    const project = await newProject();
    const worktree = await newWorktree(project);
    const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
    await withRepo((repo) => repo.setSelection(project, worktree, db.id, "own", "alice"));
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
    expect(await deleteProject()).toBe("deleted");
  });

  describe("removing a definition as its remover read it", () => {
    it("removes it while it holds the spec read, and refuses once it changed", async () => {
      const project = await newProject();
      const read = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      const changed = await withRepo((repo) =>
        add(repo, project, postgresDb({ image: "postgres:18" }), "alice"),
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
      const db = await withRepo((repo) => add(repo, project, postgresDb(), "alice"));
      expect(
        await failureOf((repo) =>
          repo.removeIfCurrent(other, { id: db.id, digest: db.specDigest }),
        ),
      ).toMatchObject({ _tag: "ResourceDefinitionNotFoundError" });
    });
  });
});
