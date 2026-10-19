import { PgClient } from "@effect/sql-pg";
import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { AgentWait, type SessionProcessKind } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { SessionProcessesRepo, SessionProcessesRepoLive } from "../src/repos/session-processes.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_process_waiting_test_${process.pid}_${Date.now()}`;
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

const PROJECT = ProjectId.make("p-web");
const WORKTREE = WorktreeId.make("wt-1");
const SESSION = SessionId.make("s-mine");
const OTHER_SESSION = SessionId.make("s-other");
const WAIT = new AgentWait({
  kind: "permission",
  tool: "Bash",
  since: new Date("2026-10-19T09:00:00.000Z"),
});

const createProcess = (kind: SessionProcessKind, sessionId: SessionId = SESSION) =>
  Effect.gen(function* () {
    const processes = yield* SessionProcessesRepo;
    return yield* processes.create({
      sessionId,
      sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
      sealantSessionId: `pty-${kind}`,
      kind,
      harness: kind === "agent-pty" ? "claude" : null,
      label: kind,
      argv: [kind],
    });
  });

describe.skipIf(postgres.skip)("a terminal agent's wait, in Postgres", () => {
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
        for (const id of [SESSION, OTHER_SESSION]) {
          yield* sessions.create({
            id,
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

  it("sets and clears the wait of a live terminal agent, and reads it back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* SessionProcessesRepo;
        const agent = yield* createProcess("agent-pty");
        const set = yield* processes.setWaiting(agent.id, SESSION, WAIT);
        const afterSet = yield* processes.byId(agent.id);
        const cleared = yield* processes.setWaiting(agent.id, SESSION, null);
        const afterClear = yield* processes.byId(agent.id);
        yield* processes.markExited(agent.id, "exited", 0);
        return { agent, set, afterSet, cleared, afterClear };
      }),
    );
    expect(result.agent.waiting).toBeNull();
    expect(result.set).toBe(true);
    expect(result.afterSet?.waiting).toEqual(WAIT);
    expect(result.cleared).toBe(true);
    expect(result.afterClear?.waiting).toBeNull();
  });

  it("refuses a wait for another session's agent, or for a row that is not a terminal agent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* SessionProcessesRepo;
        const others = yield* createProcess("agent-pty", OTHER_SESSION);
        const shell = yield* createProcess("shell");
        const protocol = yield* createProcess("agent-protocol");
        const outcomes = [
          yield* processes.setWaiting(others.id, SESSION, WAIT),
          yield* processes.setWaiting(shell.id, SESSION, WAIT),
          yield* processes.setWaiting(protocol.id, SESSION, WAIT),
        ];
        const rows = yield* Effect.forEach([others, shell, protocol], (row) =>
          processes.byId(row.id),
        );
        yield* Effect.forEach([others, shell, protocol], (row) =>
          processes.markExited(row.id, "exited", 0),
        );
        return { outcomes, waits: rows.map((row) => row?.waiting) };
      }),
    );
    expect(result.outcomes).toEqual([false, false, false]);
    expect(result.waits).toEqual([null, null, null]);
  });

  it("clears the wait when the row ends, and a late report does not bring it back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* SessionProcessesRepo;
        const exiting = yield* createProcess("agent-pty");
        yield* processes.setWaiting(exiting.id, SESSION, WAIT);
        yield* processes.markExited(exiting.id, "exited", 0);
        const late = yield* processes.setWaiting(exiting.id, SESSION, WAIT);
        const afterExit = yield* processes.byId(exiting.id);

        const reaped = yield* createProcess("agent-pty");
        yield* processes.setWaiting(reaped.id, SESSION, WAIT);
        yield* processes.reapLiveForWorkspace(SealantWorkspaceId.make("ws-1"));
        const afterReap = yield* processes.byId(reaped.id);

        const next = yield* createProcess("agent-pty");
        yield* processes.markExited(next.id, "exited", 0);
        return { late, afterExit, afterReap, next };
      }),
    );
    expect(result.late).toBe(false);
    expect(result.afterExit?.waiting).toBeNull();
    expect(result.afterReap?.waiting).toBeNull();
    expect(result.next.waiting).toBeNull();
  });

  it("records a terminal agent's session id once, and never on an ended row", async () => {
    const result = await run(
      Effect.gen(function* () {
        const processes = yield* SessionProcessesRepo;
        const agent = yield* createProcess("agent-pty");
        const first = yield* processes.claimProviderSessionId(agent.id, SESSION, "thread-a");
        const second = yield* processes.claimProviderSessionId(agent.id, SESSION, "thread-b");
        const afterClaims = yield* processes.byId(agent.id);
        const otherSession = yield* processes.claimProviderSessionId(
          (yield* createProcess("agent-pty")).id,
          OTHER_SESSION,
          "thread-c",
        );
        const ended = yield* createProcess("agent-pty");
        yield* processes.markExited(ended.id, "exited", 0);
        const late = yield* processes.claimProviderSessionId(ended.id, SESSION, "thread-d");
        const afterLate = yield* processes.byId(ended.id);
        yield* processes.markExited(agent.id, "exited", 0);
        return { first, second, afterClaims, otherSession, late, afterLate };
      }),
    );
    expect(result.first).toBe(true);
    expect(result.second).toBe(false);
    expect(result.afterClaims?.providerSessionId).toBe("thread-a");
    expect(result.otherSession).toBe(false);
    expect(result.late).toBe(false);
    expect(result.afterLate?.providerSessionId).toBeNull();
  });
});
