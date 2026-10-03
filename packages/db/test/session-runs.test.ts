import { PgClient } from "@effect/sql-pg";
import { ProjectId, SealantRunId, SealantWorkspaceId, SessionId, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import * as Str from "effect/String";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  type NewSessionRun,
  SessionRunActiveError,
  SessionRunsRepo,
  SessionRunsRepoLive,
} from "../src/repos/session-runs.ts";

/**
 * Runs against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database; skips when
 * nothing listens. MEND_TEST_DATABASE_URL points elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_session_runs_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({
  url: Redacted.make(scratchUrl),
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
});
const reposLayer = SessionRunsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SessionRunsRepo | SqlClient.SqlClient>) =>
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

const PROJECT = ProjectId.make("proj-session-runs");
const WORKTREE = WorktreeId.make("wt-session-runs");
let sessionSeq = 0;
const freshSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  sessionSeq += 1;
  const id = SessionId.make(`session-${process.pid}-${sessionSeq}`);
  yield* sql`
    INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha,
                                base_ref)
    VALUES (${id}, ${PROJECT}, ${WORKTREE}, 'claude', ${WORKTREE}, ${`mend/wt/${WORKTREE}`},
            ${"a".repeat(40)}, 'main')`;
  return id;
});

let runSeq = 0;
const runOf = (sessionId: SessionId): NewSessionRun => {
  runSeq += 1;
  return {
    sessionId,
    harness: "claude",
    sealantRunId: SealantRunId.make(`run-${process.pid}-${runSeq}`),
    sealantWorkspaceId: SealantWorkspaceId.make(`workspace-${runSeq}`),
    sealantSessionId: null,
  };
};

describe.skipIf(!reachable)("session runs repo", () => {
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
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          yield* migration;
        }
        yield* sql`
          INSERT INTO projects (id, name, organization_id, origin_url, store_path, default_branch)
          VALUES (${PROJECT}, 'session-runs-fixture', (SELECT id FROM organizations LIMIT 1), NULL,
                  '/store/session-runs-fixture/repo.git', 'main')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, ${WORKTREE}, ${WORKTREE}, ${`mend/wt/${WORKTREE}`},
                  ${"a".repeat(40)})`;
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

  it("create: a second run while one is open is the typed refusal naming the open run, never a defect", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRunsRepo;
        const sessionId = yield* freshSession;
        const first = yield* repo.create(runOf(sessionId));
        const second = runOf(sessionId);
        const refused = yield* repo.create(second).pipe(Effect.flip);
        const runs = yield* repo.listForSession(sessionId);
        return { first, second, refused, runs };
      }),
    );
    expect(seen.refused).toBeInstanceOf(SessionRunActiveError);
    expect(seen.refused.activeRun.sealantRunId).toBe(seen.first.sealantRunId);
    expect(seen.refused.sealantRunId).toBe(seen.second.sealantRunId);
    expect(seen.refused.sessionId).toBe(seen.first.sessionId);
    expect(seen.runs.map((row) => row.sealantRunId)).toEqual([seen.first.sealantRunId]);
  });

  it("create: once the open run settles, the next run lands at the next ordinal", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const repo = yield* SessionRunsRepo;
        const sessionId = yield* freshSession;
        const first = yield* repo.create(runOf(sessionId));
        yield* repo.settle(
          first.sealantRunId,
          "failed",
          "launch failed · the harness never started",
        );
        const second = yield* repo.create(runOf(sessionId));
        const settled = yield* repo.bySealantRunId(first.sealantRunId);
        const active = yield* repo.activeForSession(sessionId);
        return { first, second, settled, active };
      }),
    );
    expect(seen.second.ordinal).toBe(seen.first.ordinal + 1);
    expect(seen.settled?.status).toBe("failed");
    expect(seen.settled?.summary).toBe("launch failed · the harness never started");
    expect(seen.settled?.settledAt).not.toBeNull();
    expect(seen.active?.sealantRunId).toBe(seen.second.sealantRunId);
  });
});
