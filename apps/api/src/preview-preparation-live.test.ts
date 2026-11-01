import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepoLive,
  CheckpointsRepoLive,
  MendDBLive,
  migrations,
  PreviewPreparationsRepo,
  PreviewPreparationsRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { AgentTurnId } from "@mend/domain";
import { SessionEngine, WorktreeReads } from "@mend/sessions";
import { Duration, Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { previewPreparation } from "./preview-preparation.ts";

const postgres = postgresTestConfig();
const database = `mend_preview_preparation_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));

const SESSION = "session-live";
const PROCESS = "process-live";
const SIBLING = "session-live-2";
const SIBLING_PROCESS = "process-live-2";
const WORKTREE = "worktree-live";

const TWO_WORKERS_OVERLAP = "400 millis";
const asked: Array<string> = [];
const started: Array<string> = [];

const fakes = Layer.mergeAll(
  Layer.mock(SessionEngine, {
    launchUnderWay: () => false,
    flushCaptures: () => Effect.succeed("flushed" as const),
    preparePreview: (_session, turnId, hold) =>
      Effect.gen(function* () {
        asked.push(turnId);
        const held = yield* hold.report({
          _tag: "Starting",
          service: "web",
          previewId: null,
          phase: "setup",
          note: null,
        });
        if (held) started.push(turnId);
        yield* Effect.sleep(TWO_WORKERS_OVERLAP);
        return held
          ? { _tag: "Started" as const, service: "web", previewId: null, note: null }
          : { _tag: "Skipped" as const, why: "another start of web holds the preview" };
      }),
  }),
  Layer.mock(WorktreeReads, {
    changedFiles: () =>
      Effect.succeed({
        value: [{ path: "src/app.tsx", additions: 1, deletions: 0 }],
        stamp: {
          source: "worktree" as const,
          captureN: null,
          captureId: null,
          seq: null,
          kind: null,
          partial: false,
          observedAt: null,
        },
      }),
  }),
);

const workerLayer = () =>
  Layer.mergeAll(
    PreviewPreparationsRepoLive,
    AgentConversationRepoLive,
    SessionsRepoLive,
    WorktreesRepoLive,
    WorktreeChangesRepoLive,
    CheckpointsRepoLive,
    fakes,
  ).pipe(
    Layer.provideMerge(
      MendDBLive.pipe(
        Layer.provideMerge(PgClient.layer({ url: Redacted.make(databaseUrl.toString()) })),
      ),
    ),
  );

const inWorker = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof workerLayer>>>,
) => Effect.runPromise(effect.pipe(Effect.provide(workerLayer()), Effect.scoped));

const endTurn = (ordinal: number, session = SESSION) =>
  inWorker(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = AgentTurnId.make(`turn-live-${session}-${ordinal}`);
      const process = session === SESSION ? PROCESS : SIBLING_PROCESS;
      yield* sql`
        INSERT INTO agent_turns
          (id, session_id, process_id, ordinal, input, status, started_at, ended_at)
        VALUES (${id}, ${session}, ${process}, ${ordinal}, 'fix it', 'completed',
                now() - interval '30 seconds', now())`;
      return id;
    }),
  );

interface Worker {
  readonly publish: (sessionId: string) => Effect.Effect<void>;
}

const withWorkers = (
  workers: number,
  body: (workers: ReadonlyArray<Worker>) => Effect.Effect<void, unknown>,
  options: { readonly sweepInterval?: Duration.Duration; readonly leaseMs?: number } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const running = yield* Effect.forEach(Array.from({ length: workers }), () =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<string>();
          const fiber = yield* previewPreparation(Stream.fromQueue(events), {
            sweepInterval: options.sweepInterval ?? Duration.minutes(10),
            ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.scoped,
            Effect.provide(workerLayer()),
            Effect.forkScoped,
          );
          const worker: Worker = {
            publish: (sessionId) =>
              Queue.offer(
                events,
                JSON.stringify({ type: "agent-conversation", sessionId, projectId: "p-live" }),
              ).pipe(Effect.asVoid),
          };
          return { fiber, worker };
        }),
      );
      yield* body(running.map(({ worker }) => worker)).pipe(
        Effect.ensuring(
          Effect.forEach(running, ({ fiber }) => Fiber.interrupt(fiber), { discard: true }),
        ),
      );
    }).pipe(Effect.scoped),
  );

const decided = (turnId: string) =>
  inWorker(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly state: string; readonly decided: boolean }>`
        SELECT state, decided_at IS NOT NULL AS decided FROM preview_preparations
        WHERE turn_id = ${turnId}`;
      return rows.map((row) => ({ ...row }));
    }),
  );

const untilDecided = (turnId: string, timeout: Duration.Input = "5 seconds") =>
  Effect.gen(function* () {
    for (;;) {
      const rows = yield* Effect.promise(() => decided(turnId));
      if (rows.some((row) => row.decided)) break;
      yield* Effect.sleep("50 millis");
    }
    yield* Effect.sleep("300 millis");
  }).pipe(
    Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(`${turnId} undecided`) }),
  );

describe.skipIf(postgres.skip)("PreviewPreparationLive across API processes", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    await inWorker(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-live', 'api', '/store/p-live/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, 'p-live', 'live', 'live', 'mend/live', ${"a".repeat(40)})`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES (${SESSION}, 'p-live', ${WORKTREE}, 'claude', 'live', 'mend/live',
                  ${"a".repeat(40)}, 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES (${PROCESS}, ${SESSION}, 'ws-1', 'pty-1', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO agent_sessions
            (id, project_id, worktree_id, harness, worktree, branch, base_sha, status)
          VALUES (${SIBLING}, 'p-live', ${WORKTREE}, 'codex', 'live', 'mend/live',
                  ${"a".repeat(40)}, 'running')`;
        yield* sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, sealant_session_id, kind, status)
          VALUES (${SIBLING_PROCESS}, ${SIBLING}, 'ws-1', 'pty-2', 'agent-protocol', 'running')`;
        yield* sql`
          INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES ('change-live', 'p-live', ${WORKTREE}, ${SESSION}, 'mend/live', ${"a".repeat(40)})`;
      }),
    );
  });
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }),
    );
  });
  beforeEach(async () => {
    asked.length = 0;
    started.length = 0;
    await inWorker(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM agent_turns`;
        yield* sql`UPDATE agent_sessions SET purpose = NULL`;
      }),
    );
  });

  it("durably skips a completed setup turn without asking the engine to start anything", async () => {
    await inWorker(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_sessions SET purpose = 'setup' WHERE id = ${SESSION}`;
      }),
    );
    const turn = await endTurn(0);
    await withWorkers(1, () => untilDecided(turn));
    const rows = await inWorker(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT state, reason FROM preview_preparations WHERE turn_id = ${turn}`;
      }),
    );
    expect(rows).toMatchObject([
      { state: "skipped", reason: "setup sessions write instructions; nothing starts" },
    ]);
    expect(asked).toEqual([]);
    expect(started).toEqual([]);
  });

  it("two workers sweep a turn that ended before they started, and prepare it once", async () => {
    const turn = await endTurn(1);
    await withWorkers(2, () => untilDecided(turn));
    await withWorkers(2, () => Effect.sleep("300 millis"));
    expect(asked).toEqual([turn]);
    expect(await decided(turn)).toEqual([{ state: "started", decided: true }]);
  });

  it("an event both workers hear prepares a turn once, and a burst of events changes nothing", async () => {
    let turn = "";
    await withWorkers(2, (workers) =>
      Effect.gen(function* () {
        yield* Effect.sleep("100 millis");
        turn = yield* Effect.promise(() => endTurn(2));
        for (let index = 0; index < 5; index += 1) {
          yield* Effect.forEach(workers, (worker) => worker.publish(SESSION), { discard: true });
        }
        yield* untilDecided(turn);
      }),
    );
    expect(asked).toEqual([turn]);
    expect(await decided(turn)).toEqual([{ state: "started", decided: true }]);
  });

  it("two sessions of one worktree end changed turns at once, and one start of web runs", async () => {
    const turns: Array<string> = [];
    await withWorkers(2, (workers) =>
      Effect.gen(function* () {
        yield* Effect.sleep("100 millis");
        turns.push(yield* Effect.promise(() => endTurn(4)));
        turns.push(yield* Effect.promise(() => endTurn(4, SIBLING)));
        yield* Effect.forEach(
          workers,
          (worker) =>
            Effect.forEach([SESSION, SIBLING], (session) => worker.publish(session), {
              discard: true,
            }),
          { discard: true },
        );
        yield* Effect.forEach(turns, (turn) => untilDecided(turn), { discard: true });
      }),
    );
    expect([...asked].toSorted()).toEqual([...turns].toSorted());
    expect(started).toHaveLength(1);
    const states = await Promise.all(turns.map((turn) => decided(turn)));
    expect(
      states
        .flat()
        .map((row) => row.state)
        .toSorted(),
    ).toEqual(["skipped", "started"]);
  });

  it("the minute's pass retakes a claim whose worker died, once its lease lapsed", async () => {
    const turn = await endTurn(3);
    const held = await inWorker(
      Effect.flatMap(PreviewPreparationsRepo, (repo) => repo.claim(turn, 1_500)),
    );
    expect(held).not.toBeNull();
    await withWorkers(
      1,
      () =>
        Effect.gen(function* () {
          yield* Effect.sleep("600 millis");
          expect(asked, "the dead worker's lease still holds").toEqual([]);
          yield* untilDecided(turn);
        }),
      { sweepInterval: Duration.millis(200) },
    );
    expect(asked).toEqual([turn]);
    expect(await decided(turn)).toEqual([{ state: "started", decided: true }]);
  });
});
