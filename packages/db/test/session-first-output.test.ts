import { PgClient } from "@effect/sql-pg";
import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { SessionProcessesRepo, SessionProcessesRepoLive } from "../src/repos/session-processes.ts";

/**
 * `first_output_at` (0095) against Postgres in a throwaway database: when an agent's record first
 * carried output (alpha 2026-09-30, fda7180d: a claude on a new machine drew ~45 s after it
 * started). Only the first stamp takes. Without a database reachable these skip; set
 * MEND_TEST_DATABASE_URL.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_first_output_test_${process.pid}_${Date.now()}`;
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
const SESSION = SessionId.make("s-launched");

describe.skipIf(!reachable)("an agent process's first output, in Postgres", () => {
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
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        yield* sessions.create({
          id: SESSION,
          projectId: PROJECT,
          worktreeId: WORKTREE,
          harness: "claude",
          label: null,
          worktree: "wt-1",
          branch: "mend/wt-1",
          baseSha: Sha.make("abc"),
          baseRef: "main",
          contextSnapshotId: null,
          ownerUserId: "alice",
          origin: "mend",
        });
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

  it("is null until stamped, then keeps the first stamp", async () => {
    const first = new Date("2026-09-30T17:15:41.000Z");
    const later = new Date("2026-09-30T17:16:10.000Z");
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* SessionProcessesRepo;
        const agent = yield* processes.create({
          sessionId: SESSION,
          sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
          sealantSessionId: "pty-1",
          kind: "agent-pty",
          harness: "claude",
          label: "claude",
          argv: ["claude"],
        });
        const stampedFirst = yield* processes.markFirstOutput(agent.id, first);
        const stampedAgain = yield* processes.markFirstOutput(agent.id, later);
        const after = yield* processes.byId(agent.id);
        const listed = yield* processes.listForSession(SESSION);
        return { agent, stampedFirst, stampedAgain, after, listed };
      }),
    );
    expect(result.agent.firstOutputAt).toBeNull();
    expect(result.stampedFirst).toBe(true);
    expect(result.stampedAgain).toBe(false);
    expect(result.after?.firstOutputAt?.getTime()).toBe(first.getTime());
    expect(result.listed.map((process) => process.firstOutputAt?.getTime())).toEqual([
      first.getTime(),
    ]);
  });

  it("records the session's owner as someone who had a session in its worktree, durably", async () => {
    const owners = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* SessionsRepo).remove(SESSION);
        return yield* sql<{ readonly userId: string }>`
          SELECT user_id AS "userId" FROM worktree_session_owners WHERE worktree_id = ${WORKTREE}`;
      }),
    );
    // Kept after the session is deleted (docs/adr/0016, decision 14).
    expect(owners.map((row) => row.userId)).toEqual(["alice"]);
  });
});
