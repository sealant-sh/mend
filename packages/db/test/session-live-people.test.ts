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
 * The people live in a session's executor (docs/adr/0016, decision 13), read in the same query as
 * the API's session list and view, against Postgres in a throwaway database; and that query's
 * latency against the plain list's (Performance: session list and view within +5% or +20 ms).
 * Without a database reachable these skip; set MEND_TEST_DATABASE_URL.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
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
const OTHER = WorktreeId.make("wt-2");

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

/** Median and 90th percentile of 40 runs, in milliseconds. */
const time = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const samples: Array<number> = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      yield* effect;
      samples.push(performance.now() - started);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
    };
  });

/** The budget for session list and view latency (Performance): +5% or +20 ms, whichever is larger. */
const within = (before: number, after: number) => after <= Math.max(before * 1.05, before + 20);

describe.skipIf(!reachable)("the people live in a session's executor, in Postgres", () => {
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
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("lists each person live in a per-person executor once, by name, and nobody in a shared one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const listed = yield* sessions.listActiveView();
        const view = yield* sessions.viewById(SessionId.make("s-maria"));
        const plain = yield* sessions.byId(SessionId.make("s-maria"));
        return { listed, view, plain };
      }),
    );
    const people = Object.fromEntries(
      result.listed.map((session) => [
        session.id,
        session.livePeople.map((person) => [person.accountId, person.name]),
      ]),
    );
    expect(people).toEqual({
      "s-alice": [
        ["alice", "Alice"],
        ["maria", "maria@example.com"],
      ],
      "s-maria": [
        ["alice", "Alice"],
        ["maria", "maria@example.com"],
      ],
      "s-carol": [],
    });
    expect(result.view.livePeople.map((person) => person.accountId)).toEqual(["alice", "maria"]);
    // Every other read leaves it empty.
    expect(result.plain.livePeople).toEqual([]);
  });

  it("reads the list and the view within the budget of the plain reads (+5% or +20 ms)", async () => {
    const timings = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionsRepo;
        // A busy instance: 300 live sessions, each executor with two people's processes.
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status,
             owner_user_id, sealant_workspace_id)
          SELECT 'bulk-' || g, ${PROJECT}, ${WORKTREE}, 'claude', 'wt-1', 'mend/wt-1', 'abc',
                 'running', 'alice', 'ws-bulk-' || (g / 2)
          FROM generate_series(1, 300) g`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status, runs_as)
          SELECT 'bulk-p-' || g, 'bulk-' || g, 'ws-bulk-' || (g / 2), 'pty-b-' || g,
                 'agent-pty', 'running', CASE WHEN g % 2 = 0 THEN 'alice' ELSE 'maria' END
          FROM generate_series(1, 300) g`;
        yield* sql`ANALYZE`;
        const id = SessionId.make("bulk-17");
        // Interleaved warm-up, then each measured.
        yield* time(sessions.listActive());
        yield* time(sessions.listActiveView());
        return {
          list: yield* time(sessions.listActive()),
          listView: yield* time(sessions.listActiveView()),
          byId: yield* time(sessions.byId(id)),
          view: yield* time(sessions.viewById(id)),
        };
      }),
    );
    console.log(`session list and view latency (ms): ${JSON.stringify(timings)}`);
    expect(within(timings.list.median, timings.listView.median)).toBe(true);
    expect(within(timings.list.p90, timings.listView.p90)).toBe(true);
    expect(within(timings.byId.median, timings.view.median)).toBe(true);
    expect(within(timings.byId.p90, timings.view.p90)).toBe(true);
  });
});
