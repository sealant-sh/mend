import { PgClient } from "@effect/sql-pg";
import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { SessionProcessesRepo, SessionProcessesRepoLive } from "../src/repos/session-processes.ts";
import { postgresTestConfig } from "./postgres.ts";

export const PROJECT = ProjectId.make("p-web");
export const WORKTREE = WorktreeId.make("wt-1");
export const OTHER = WorktreeId.make("wt-2");

const newSession = (id: string, worktree: WorktreeId, owner: string) => ({
  id: SessionId.make(id),
  projectId: PROJECT,
  worktreeId: worktree,
  harness: "claude",
  label: null,
  worktree: worktree,
  branch: `mend/${worktree}`,
  baseSha: Sha.make("abc"),
  baseRef: "main",
  contextSnapshotId: null,
  ownerUserId: owner,
  origin: "mend" as const,
});

/** Shared real PostgreSQL fixture for semantic checks and the explicit latency benchmark. */
export const createLivePeopleFixture = () => {
  /** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
  const postgres = postgresTestConfig();
  const ADMIN_URL = postgres.adminUrl;
  const SCRATCH_DB = `mend_live_people_test_${process.pid}_${Date.now()}`;
  const scratchUrl = (() => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${SCRATCH_DB}`;
    return url.toString();
  })();
  const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
  const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
  const reposLayer = Layer.mergeAll(SessionsRepoLive, SessionProcessesRepoLive).pipe(
    Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
  );

  const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
  const run = <A, E>(
    effect: Effect.Effect<A, E, SessionsRepo | SessionProcessesRepo | SqlClient.SqlClient>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

  const setup = async () => {
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
        const processes = yield* SessionProcessesRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email") VALUES
            ('alice', 'Alice', 'alice@example.com'),
            ('maria', '', 'maria@example.com')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-1', 'wt-1', 'mend/wt-1', 'abc'),
                 (${OTHER}, ${PROJECT}, 'wt-2', 'wt-2', 'mend/wt-2', 'abc')`;
        // Alice's session and Maria's join share a per-person executor; Carol's runs shared.
        for (const [id, worktree, owner, workspace] of [
          ["s-alice", WORKTREE, "alice", "ws-person"],
          ["s-maria", WORKTREE, "maria", "ws-person"],
          ["s-carol", OTHER, "carol", "ws-shared"],
        ] as const) {
          yield* sessions.create(newSession(id, worktree, owner));
          yield* sql`
            UPDATE agent_sessions SET status = 'running', sealant_workspace_id = ${workspace}
            WHERE id = ${id}`;
        }
        const agent = (session: string, workspace: string, runsAs: string | null) =>
          processes.create({
            sessionId: SessionId.make(session),
            sealantWorkspaceId: SealantWorkspaceId.make(workspace),
            sealantSessionId: `pty-${session}`,
            kind: "agent-pty",
            harness: "claude",
            label: "claude",
            argv: ["claude"],
            runsAs,
          });
        yield* agent("s-alice", "ws-person", "alice");
        yield* agent("s-maria", "ws-person", "maria");
        // Alice's shell is one more of her processes there: she is listed once.
        yield* agent("s-alice", "ws-person", "alice");
        const ended = yield* agent("s-maria", "ws-person", "nobody-anymore");
        yield* sql`UPDATE session_processes SET exited_at = now() WHERE id = ${ended.id}`;
        yield* agent("s-carol", "ws-shared", null);
      }),
    );
  };

  const teardown = async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  };

  return { postgres, run, setup, teardown };
};
