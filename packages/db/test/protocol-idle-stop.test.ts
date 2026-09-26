import { PgClient } from "@effect/sql-pg";
import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import {
  SessionControlEventsRepo,
  SessionControlEventsRepoLive,
} from "../src/repos/session-control-events.ts";

/**
 * The idle stop's claim (MEND_PROTOCOL_IDLE_STOP_MINUTES) against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database: one worker of many stops a session, never
 * while a turn is in flight or a request waits, and a reopen lets a later idle spell claim again.
 * Without a database reachable these skip; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_idle_stop_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(SessionsRepoLive, SessionControlEventsRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

type Repos = SessionsRepo | SessionControlEventsRepo | SqlClient.SqlClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
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
const IDLE = SessionId.make("s-idle");
const TURNING = SessionId.make("s-turning");
const ASKING = SessionId.make("s-asking");
const SETTLED = SessionId.make("s-settled");

/** Long before any claim a test makes: nothing is stale. */
const LONG_AGO = new Date("2020-01-01T00:00:00Z");

describe.skipIf(!reachable)("the idle stop's claim, in Postgres", () => {
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
          VALUES ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z')`;
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
          ownerUserId: "alice",
          origin: "slack" as const,
        };
        for (const id of [IDLE, TURNING, ASKING, SETTLED]) {
          yield* sessions.create({ ...base, id });
          yield* sessions.setStatus(id, "running");
          yield* sql`
            INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, status)
            VALUES (${`agent-${id}`}, ${id}, 'ws-1', 'agent-protocol', 'running')`;
          yield* sql`
            INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status)
            VALUES (${`turn-${id}`}, ${id}, ${`agent-${id}`}, 1, 'fix it',
                    ${id === TURNING ? "running" : "completed"})`;
        }
        yield* sql`
          INSERT INTO agent_requests
            (id, session_id, process_id, turn_id, kind, provider_request_id, status)
          VALUES ('request-1', ${ASKING}, ${`agent-${ASKING}`}, ${`turn-${ASKING}`},
                  'user-input', 'provider-request-1', 'pending')`;
        yield* sessions.settle(SETTLED, "completed", null);
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

  it("lets exactly one of several workers claim an idle session", async () => {
    const claims = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        return yield* Effect.all(
          Array.from({ length: 4 }, () => sessions.claimIdleStop(IDLE, LONG_AGO)),
          { concurrency: "unbounded" },
        );
      }),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const session = await run(
      Effect.gen(function* () {
        return yield* (yield* SessionsRepo).byId(IDLE);
      }),
    );
    expect(session.idleStoppedAt).not.toBeNull();
  });

  it("refuses a session with a turn in flight, a pending request, or that has settled", async () => {
    const claims = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        return yield* Effect.all([
          sessions.claimIdleStop(TURNING, LONG_AGO),
          sessions.claimIdleStop(ASKING, LONG_AGO),
          sessions.claimIdleStop(SETTLED, LONG_AGO),
        ]);
      }),
    );
    expect(claims).toEqual([false, false, false]);
  });

  it("takes a stale claim again, gives one back, and clears it when the session reopens", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        // Still held by the first test's claim; older than a moment from now, so stale then.
        expect(yield* sessions.claimIdleStop(IDLE, LONG_AGO)).toBe(false);
        expect(yield* sessions.claimIdleStop(IDLE, new Date(Date.now() + 60_000))).toBe(true);

        yield* sessions.releaseIdleStop(IDLE);
        expect((yield* sessions.byId(IDLE)).idleStoppedAt).toBeNull();
        expect(yield* sessions.claimIdleStop(IDLE, LONG_AGO)).toBe(true);

        // The stop settles it; the next reply reopens it, and a later idle spell may claim again.
        yield* sessions.settle(IDLE, "stopped", "idle · stopped after 15 min · reply to resume");
        expect(yield* sessions.claimIdleStop(IDLE, LONG_AGO)).toBe(false);
        const stopped = yield* sessions.byId(IDLE);
        expect(stopped.status).toBe("stopped");
        expect(stopped.idleStoppedAt).not.toBeNull();
        yield* sessions.reopen(IDLE, "running");
        expect((yield* sessions.byId(IDLE)).idleStoppedAt).toBeNull();
        expect(yield* sessions.claimIdleStop(IDLE, LONG_AGO)).toBe(true);
      }),
    );
  });

  it("records the stop in the control log as idle-stop", async () => {
    const kinds = await run(
      Effect.gen(function* () {
        const control = yield* SessionControlEventsRepo;
        yield* control.record({
          sessionId: IDLE,
          actorUserId: "alice",
          kind: "idle-stop",
          refId: `agent-${IDLE}`,
        });
        return (yield* control.listForSession(IDLE)).map((event) => [event.kind, event.refId]);
      }),
    );
    expect(kinds).toEqual([["idle-stop", `agent-${IDLE}`]]);
  });
});
