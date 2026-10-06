import { PgClient } from "@effect/sql-pg";
import {
  ProjectId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";

/**
 * Who created a workspace (0114, `SessionsRepo.executorSessionOf`): the session whose row names it
 * under a launch of its own, never one that joined it (alpha 2026-10-06, 9e486cfc). Against the dev
 * Postgres (`compose.dev.yaml`, :5434) in a throwaway database; skips without one. Set
 * MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_executor_session_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = SessionsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SessionsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const PROJECT = ProjectId.make("p-web");
const WORKTREE = WorktreeId.make("wt-1");
const HOLDER = SessionId.make("s-holder");
const JOINER = SessionId.make("s-joiner");
const WORKSPACE = SealantWorkspaceId.make("ws-holder");

describe.skipIf(!reachable)("who created a workspace (0114), in Postgres", () => {
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
        const sessions = yield* SessionsRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES
            ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
            ('maria', 'Maria', 'maria@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        const base = {
          projectId: PROJECT,
          worktreeId: WORKTREE,
          harness: "claude",
          label: null,
          worktree: "wt-1",
          branch: "mend/wt-1",
          baseSha: Sha.make("abc"),
          baseRef: "main",
          contextSnapshotId: null,
          origin: "mend" as const,
        };
        yield* sessions.create({ ...base, id: HOLDER, ownerUserId: "alice" });
        yield* sessions.create({ ...base, id: JOINER, ownerUserId: "maria" });
        // The holder's launch made the executor; the joiner's row names it with no launch.
        yield* sessions.recordAcceptedWorkspace(HOLDER, WORKSPACE, new Date(), "launch-1");
        yield* sessions.setSealantIds(JOINER, SealantRunId.make("run-joined"), WORKSPACE);
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

  it("names the session whose own launch made the workspace, never one that joined it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const creator = yield* sessions.executorSessionOf(WORKSPACE);
        const unknown = yield* sessions.executorSessionOf(SealantWorkspaceId.make("ws-unknown"));
        return { creator: creator?.id ?? null, owner: creator?.ownerUserId ?? null, unknown };
      }),
    );
    expect(result).toEqual({ creator: HOLDER, owner: "alice", unknown: null });
  });

  it("finds it through the partial index on the workspace", async () => {
    const indexes = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly indexdef: string }>`
          SELECT indexdef FROM pg_indexes
          WHERE indexname = 'agent_sessions_executor_workspace_idx'`;
      }),
    );
    expect(indexes.map((row) => row.indexdef)).toEqual([
      expect.stringContaining("WHERE (executor_launch_id IS NOT NULL)"),
    ]);
  });
});
