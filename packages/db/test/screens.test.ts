import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  ViewerConnectionId,
} from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { makeScreensMemory, ScreensRepo, ScreensRepoLive } from "../src/repos/screens.ts";
import { postgresTestConfig } from "./postgres.ts";

interface ScreenFixture {
  readonly screens: ScreensRepo["Service"];
  readonly session: () => Effect.Effect<SessionId>;
  readonly agentProcess: (sessionId: SessionId) => Effect.Effect<SessionProcessId>;
}

type RunFixture = (work: (fixture: ScreenFixture) => Effect.Effect<void, unknown>) => Promise<void>;

const workspace = () => SealantWorkspaceId.make(`ws-${randomUUID()}`);
const OWNER = "alice";

const screenContract = (runFixture: RunFixture) => {
  it("gives two sessions in one workspace two displays, kept across an idle stop", async () =>
    runFixture(({ screens, session, agentProcess }) =>
      Effect.gen(function* () {
        const ws = workspace();
        const [a, b] = [yield* session(), yield* session()];
        const first = yield* screens.reserve({ sessionId: a, workspaceId: ws });
        const second = yield* screens.reserve({ sessionId: b, workspaceId: ws });
        expect([first.display, second.display]).toEqual([10, 11]);
        expect(first.life).toEqual({ _tag: "NotStarted" });
        expect(first.input).toEqual({ _tag: "AwaitingAgent", epoch: 0 });

        const process = yield* agentProcess(a);
        yield* screens.setLife(first.id, { life: { _tag: "Starting" }, processId: process });
        const live = yield* screens.setLife(first.id, {
          life: { _tag: "Live", degraded: null },
          processId: process,
        });
        expect(live.processId).toBe(process);
        const stopped = yield* screens.setLife(first.id, {
          life: { _tag: "Ended", reason: "idle" },
        });
        expect(stopped.processId).toBeNull();

        const again = yield* screens.reserve({ sessionId: a, workspaceId: ws });
        expect(again.id).toBe(first.id);
        expect(again.display).toBe(10);
        expect(yield* screens.ofSession(a)).toEqual(again);
      }),
    ));

  it("releases a display when its session ends, for the workspace's next session", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const ws = workspace();
        const ended = yield* session();
        const reserved = yield* screens.reserve({ sessionId: ended, workspaceId: ws });
        yield* screens.release(ended);
        yield* screens.release(ended);
        expect(yield* screens.ofSession(ended)).toBeNull();
        expect((yield* screens.byId(reserved.id))?.life).toEqual({
          _tag: "Ended",
          reason: "session-stopped",
        });
        const next = yield* screens.reserve({ sessionId: yield* session(), workspaceId: ws });
        expect(next.display).toBe(reserved.display);
      }),
    ));

  it("keeps a session's display number in its next workspace and frees it in the last", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const [first, second] = [workspace(), workspace()];
        const [a, b] = [yield* session(), yield* session()];
        yield* screens.reserve({ sessionId: a, workspaceId: first });
        const before = yield* screens.reserve({ sessionId: b, workspaceId: first });
        const moved = yield* screens.reserve({ sessionId: b, workspaceId: second });
        expect(moved.id).not.toBe(before.id);
        expect(moved.display).toBe(before.display);
        expect((yield* screens.byId(before.id))?.life).toEqual({
          _tag: "Ended",
          reason: "workspace-ended",
        });
        const reused = yield* screens.reserve({ sessionId: yield* session(), workspaceId: first });
        expect(reused.display).toBe(before.display);
      }),
    ));

  it("refuses a full workspace", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const ws = workspace();
        for (let n = 0; n < 90; n++) {
          yield* screens.reserve({ sessionId: yield* session(), workspaceId: ws });
        }
        const refused = yield* Effect.flip(
          screens.reserve({ sessionId: yield* session(), workspaceId: ws }),
        );
        expect(refused).toMatchObject({ _tag: "ScreenDisplaysFullError", workspaceId: ws });
      }),
    ));

  it("stores only what the input machine decides", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const screen = yield* screens.reserve({
          sessionId: yield* session(),
          workspaceId: workspace(),
        });
        const connection = ViewerConnectionId.make("c-1");
        expect(
          yield* screens.control(screen.id, { _tag: "Take", by: "bob", connection }, OWNER),
        ).toEqual({ _tag: "Refused", why: "owner-only" });
        const took = yield* screens.control(
          screen.id,
          { _tag: "Take", by: OWNER, connection },
          OWNER,
        );
        expect(took).toMatchObject({ _tag: "Changed", next: { _tag: "Fencing", epoch: 1 } });
        yield* screens.control(screen.id, { _tag: "Fenced", epoch: 1 }, OWNER);
        expect((yield* screens.byId(screen.id))?.input).toEqual({
          _tag: "Person",
          epoch: 1,
          userId: OWNER,
          connection,
        });
        const missing = yield* Effect.flip(
          screens.control(ScreenId.make("missing"), { _tag: "AgentLooked" }, OWNER),
        );
        expect(missing).toMatchObject({ _tag: "ScreenNotFoundError" });
      }),
    ));
};

const runMemoryContract: RunFixture = (work) =>
  Effect.runPromise(
    work({
      screens: makeScreensMemory(),
      session: () => Effect.sync(() => SessionId.make(`s-${randomUUID()}`)),
      agentProcess: () => Effect.sync(() => SessionProcessId.make(`p-${randomUUID()}`)),
    }).pipe(Effect.orDie),
  );

describe("screens in memory", () => screenContract(runMemoryContract));

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_screens_test_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = ScreensRepoLive.pipe(
  Layer.provideMerge(
    MendDBLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
    ),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, ScreensRepo | SqlClient.SqlClient | PgClient.PgClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const postgresFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const screens = yield* ScreensRepo;
  const session = () =>
    Effect.gen(function* () {
      const id = SessionId.make(`s-${randomUUID()}`);
      yield* sql`INSERT INTO agent_sessions
          (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
        VALUES (${id}, 'p-screens', 'wt-screens', ${OWNER}, 'claude', 'screens', 'mend/screens',
                ${"a".repeat(40)}, 'running')`;
      return id;
    }).pipe(Effect.orDie);
  const agentProcess = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const id = SessionProcessId.make(`p-${randomUUID()}`);
      yield* sql`INSERT INTO session_processes
          (id, session_id, sealant_workspace_id, kind, harness, status, created_at)
        VALUES (${id}, ${sessionId}, 'ws', 'agent-protocol', 'claude', 'running', now())`;
      return id;
    }).pipe(Effect.orDie);
  return { screens, session, agentProcess } satisfies ScreenFixture;
});

const runPostgresContract: RunFixture = (work) =>
  run(Effect.flatMap(postgresFixture, work).pipe(Effect.orDie));

let scratchCreated = false;

describe.skipIf(postgres.skip)("screens in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`)),
    );
    scratchCreated = true;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
          VALUES (${OWNER}, 'Alice', 'alice@example.invalid', '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-screens', 'screens', '/store/p-screens/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-screens', 'p-screens', 'screens', 'screens', 'mend/screens',
                  ${"a".repeat(40)})`;
      }),
    );
  });

  afterAll(async () => {
    if (!scratchCreated) return;
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`),
      ),
    );
  });

  describe("shared contract", () => screenContract(runPostgresContract));

  it("gives concurrent reservations in one workspace distinct displays", async () =>
    runPostgresContract(({ screens, session }) =>
      Effect.gen(function* () {
        const ws = workspace();
        const sessions = yield* Effect.all(Array.from({ length: 12 }, session));
        const reserved = yield* Effect.all(
          sessions.map((sessionId) => screens.reserve({ sessionId, workspaceId: ws })),
          { concurrency: "unbounded" },
        );
        expect(reserved.map((screen) => screen.display).toSorted((a, b) => a - b)).toEqual(
          Array.from({ length: 12 }, (_, n) => 10 + n),
        );
      }),
    ));

  it("answers one screen to a session's concurrent reservations", async () =>
    runPostgresContract(({ screens, session }) =>
      Effect.gen(function* () {
        const sessionId = yield* session();
        const ws = workspace();
        const reserved = yield* Effect.all(
          Array.from({ length: 8 }, () => screens.reserve({ sessionId, workspaceId: ws })),
          { concurrency: "unbounded" },
        );
        expect(new Set(reserved.map((screen) => screen.id)).size).toBe(1);
      }),
    ));

  it("serializes concurrent takes into one epoch each", async () =>
    runPostgresContract(({ screens, session }) =>
      Effect.gen(function* () {
        const screen = yield* screens.reserve({
          sessionId: yield* session(),
          workspaceId: workspace(),
        });
        const connections = Array.from({ length: 6 }, (_, n) => ViewerConnectionId.make(`c-${n}`));
        const taken = yield* Effect.all(
          connections.map((connection) =>
            screens.control(screen.id, { _tag: "Take", by: OWNER, connection }, OWNER),
          ),
          { concurrency: "unbounded" },
        );
        const epochs = taken.flatMap((transition) =>
          transition._tag === "Changed" ? [transition.next.epoch] : [],
        );
        expect(epochs.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
        const last = taken.find(
          (transition) => transition._tag === "Changed" && transition.next.epoch === 6,
        );
        expect((yield* screens.byId(screen.id))?.input).toEqual(
          last?._tag === "Changed" ? last.next : null,
        );
      }),
    ));
});
