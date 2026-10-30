import { PgClient } from "@effect/sql-pg";
import { WorktreeId } from "@mend/domain";
import { RecipeSpec, RepoRelativePath, SetupDeclaration } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { RecipeApprovalsRepo, RecipeApprovalsRepoLive } from "../src/repos/recipe-approvals.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_recipe_approvals_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = RecipeApprovalsRepoLive.pipe(
  Layer.provideMerge(
    MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl) }))),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, RecipeApprovalsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const PROJECT = "recipe-approvals-project";
const WORKTREE = WorktreeId.make("recipe-approvals-worktree");
const REMOVED = WorktreeId.make("recipe-approvals-removed");

const spec = (command: string) =>
  new RecipeSpec({
    argv: ["sh", "-c", command],
    cwd: RepoRelativePath.make("apps/web"),
    env: { NODE_ENV: "development" },
    depends: [{ name: "db", digest: "d-db" }],
    setup: new SetupDeclaration({
      run: ["pnpm install --frozen-lockfile"],
      inputs: [RepoRelativePath.make("pnpm-lock.yaml")],
    }),
  });

describe.skipIf(postgres.skip)("recipe_approvals: the owner's approved recipe digests", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'approvals', '/store/p/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        for (const id of [WORKTREE, REMOVED]) {
          yield* sql`
            INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${id}, ${PROJECT}, ${id}, ${id}, ${`mend/${id}`}, 'abc')`;
        }
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("keeps one approval per name and approver: their next Start replaces it, another's stays apart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RecipeApprovalsRepo;
        yield* repo.approve(WORKTREE, [
          { serviceName: "web", digest: "d-1", approvedBy: "alice", spec: spec("pnpm dev") },
          { serviceName: "db", digest: "d-db", approvedBy: "alice", spec: spec("postgres") },
        ]);
        const first = yield* repo.forWorktree(WORKTREE, "alice");
        yield* repo.approve(WORKTREE, [
          { serviceName: "web", digest: "d-m", approvedBy: "maria", spec: spec("pnpm dev --m") },
        ]);
        yield* repo.approve(WORKTREE, [
          { serviceName: "web", digest: "d-2", approvedBy: "alice", spec: spec("pnpm dev --open") },
        ]);
        return {
          first,
          alice: yield* repo.forWorktree(WORKTREE, "alice"),
          maria: yield* repo.forWorktree(WORKTREE, "maria"),
        };
      }),
    );
    expect(result.first.get("web")?.digest).toBe("d-1");
    const web = result.alice.get("web");
    expect({ digest: web?.digest, approvedBy: web?.approvedBy, spec: web?.spec }).toEqual({
      digest: "d-2",
      approvedBy: "alice",
      spec: spec("pnpm dev --open"),
    });
    expect(web?.approvedAt).toBeInstanceOf(Date);
    expect([...result.alice.keys()].toSorted()).toEqual(["db", "web"]);
    expect(result.alice.get("db")?.digest).toBe("d-db");
    expect(
      [...result.maria.values()].map(({ serviceName, digest }) => ({ serviceName, digest })),
    ).toEqual([{ serviceName: "web", digest: "d-m" }]);
  });

  it("goes with its worktree", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* RecipeApprovalsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.approve(REMOVED, [
          { serviceName: "web", digest: "d-1", approvedBy: "alice", spec: spec("pnpm dev") },
        ]);
        const before = (yield* repo.forWorktree(REMOVED, "alice")).size;
        yield* sql`DELETE FROM worktrees WHERE id = ${REMOVED}`;
        const rows = yield* sql`SELECT 1 FROM recipe_approvals WHERE worktree_id = ${REMOVED}`;
        return { before, after: rows.length };
      }),
    );
    expect(result).toEqual({ before: 1, after: 0 });
  });
});
