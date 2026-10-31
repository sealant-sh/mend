import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  AgentTurnId,
  ScreenFrameId,
  ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  ViewerConnectionId,
} from "@mend/domain";
import { FrameDigest, type ScreenAction, screenActionNote } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  makeScreensMemory,
  type NewScreenLogEntry,
  type ScreenAgentAnswer,
  type ScreenCallArguments,
  screenCallDigest,
  ScreensRepo,
  ScreensRepoLive,
} from "../src/repos/screens.ts";
import { postgresTestConfig } from "./postgres.ts";

interface ScreenFixture {
  readonly screens: ScreensRepo["Service"];
  readonly session: () => Effect.Effect<SessionId>;
  readonly agentProcess: (sessionId: SessionId) => Effect.Effect<SessionProcessId>;
}

type RunFixture = (work: (fixture: ScreenFixture) => Effect.Effect<void, unknown>) => Promise<void>;

const workspace = () => SealantWorkspaceId.make(`ws-${randomUUID()}`);
const OWNER = "alice";
const TYPED = "correct horse battery staple";
const typing: ScreenAction = { kind: "type", text: TYPED };
const act = (...actions: [ScreenAction, ...Array<ScreenAction>]): ScreenCallArguments => ({
  tool: "screen_act",
  params: { actions },
});
const frame = (n: number) => ({
  id: ScreenFrameId.make(`frame-${n}`),
  digest: FrameDigest.make(n.toString(16).padStart(64, "0")),
});
const acted = (processId: SessionProcessId, n: number): ScreenAgentAnswer => ({
  processId,
  turnId: null,
  body: { _tag: "Acted", notes: [screenActionNote(typing, "done")] },
  frame: frame(n),
});

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
          life: { _tag: "Live", degraded: null, browserSandboxOff: false },
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

  it("dates a screen's last activity by its newest entry, change of holder or change of life", async () =>
    runFixture(({ screens, session, agentProcess }) =>
      Effect.gen(function* () {
        const sessionId = yield* session();
        const screen = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        expect(yield* screens.lastActivityAt(screen.id)).toBeInstanceOf(Date);
        yield* Effect.sleep("20 millis");
        const entry = yield* screens.append({
          screenId: screen.id,
          actor: { _tag: "Mend" },
          body: { _tag: "Started" },
          frame: null,
        });
        expect((yield* screens.lastActivityAt(screen.id))?.getTime()).toBe(entry.at.getTime());
        yield* Effect.sleep("20 millis");
        yield* screens.setLife(screen.id, {
          life: { _tag: "Starting" },
          processId: yield* agentProcess(sessionId),
        });
        const started = yield* screens.lastActivityAt(screen.id);
        expect(started?.getTime()).toBeGreaterThan(entry.at.getTime());
        yield* Effect.sleep("20 millis");
        yield* screens.control(
          screen.id,
          { _tag: "Take", by: OWNER, connection: ViewerConnectionId.make("c-1") },
          OWNER,
        );
        expect((yield* screens.lastActivityAt(screen.id))?.getTime()).toBeGreaterThan(
          started?.getTime() ?? Number.POSITIVE_INFINITY,
        );
        expect(yield* screens.lastActivityAt(ScreenId.make("missing"))).toBeNull();
      }),
    ));

  it("reads the latest screen after its display is released, and follows its next workspace", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const sessionId = yield* session();
        expect(yield* screens.latestForSession(sessionId)).toBeNull();
        const first = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        yield* screens.setLife(first.id, { life: { _tag: "Ended", reason: "idle" } });
        yield* screens.release(first.id);
        expect(yield* screens.ofSession(sessionId)).toBeNull();
        expect((yield* screens.latestForSession(sessionId))?.life).toEqual({
          _tag: "Ended",
          reason: "idle",
        });
        const next = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        expect(yield* screens.latestForSession(sessionId)).toEqual(next);
        yield* screens.release(next.id);
        expect((yield* screens.latestForSession(sessionId))?.id).toBe(next.id);
      }),
    ));

  it("releases a display when its session ends, for the workspace's next session", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const ws = workspace();
        const ended = yield* session();
        const reserved = yield* screens.reserve({ sessionId: ended, workspaceId: ws });
        const heldIds = () =>
          Effect.map(screens.listHeld(), (held) => held.map((screen) => screen.id));
        expect(yield* heldIds()).toContain(reserved.id);
        yield* screens.release(reserved.id);
        yield* screens.release(reserved.id);
        expect(yield* screens.ofSession(ended)).toBeNull();
        expect(yield* heldIds()).not.toContain(reserved.id);
        expect((yield* screens.byId(reserved.id))?.life).toEqual({
          _tag: "Ended",
          reason: "session-stopped",
        });
        const next = yield* screens.reserve({ sessionId: yield* session(), workspaceId: ws });
        expect(next.display).toBe(reserved.display);
      }),
    ));

  it("releases only the reservation it names, so one its session took since keeps its display", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const [first, second] = [workspace(), workspace()];
        const sessionId = yield* session();
        const decided = yield* screens.reserve({ sessionId, workspaceId: first });
        yield* screens.release(decided.id);
        const taken = yield* screens.reserve({ sessionId, workspaceId: first });
        expect(taken.id).not.toBe(decided.id);
        expect(taken.display).toBe(decided.display);
        yield* screens.release(decided.id);
        expect(yield* screens.ofSession(sessionId)).toEqual(taken);
        const next = yield* screens.reserve({ sessionId: yield* session(), workspaceId: first });
        expect(next.display).not.toBe(taken.display);

        const moved = yield* screens.reserve({ sessionId, workspaceId: second });
        yield* screens.release(taken.id);
        expect(yield* screens.ofSession(sessionId)).toEqual(moved);
        expect((yield* screens.byId(taken.id))?.life).toEqual({
          _tag: "Ended",
          reason: "workspace-ended",
        });
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

  it("numbers a screen's log from one, the machine's entries among them", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const screen = yield* screens.reserve({
          sessionId: yield* session(),
          workspaceId: workspace(),
        });
        const connection = ViewerConnectionId.make("c-1");
        yield* screens.append({
          screenId: screen.id,
          actor: { _tag: "Mend" },
          body: { _tag: "Started" },
          frame: null,
        });
        yield* screens.control(screen.id, { _tag: "Take", by: OWNER, connection }, OWNER);
        yield* screens.control(screen.id, { _tag: "Fenced", epoch: 1 }, OWNER, frame(2));
        yield* screens.append({
          screenId: screen.id,
          actor: { _tag: "Person", userId: OWNER },
          body: { _tag: "PersonInput", clicks: 2, keys: 5, pastes: 0 },
          frame: frame(1),
        });
        const log = yield* screens.log(screen.id);
        expect(log.map((entry) => [entry.seq, entry.actor._tag, entry.body._tag])).toEqual([
          [1, "Mend", "Started"],
          [2, "Person", "Taken"],
          [3, "Person", "PersonInput"],
        ]);
        expect(log[1]?.frame).toEqual({ ...frame(2), state: "stored" });
        expect(log[2]?.frame).toEqual({ ...frame(1), state: "stored" });
        expect((yield* screens.held()).map((held) => held.id)).toContain(screen.id);
        const missing = yield* Effect.flip(
          screens.append({
            screenId: ScreenId.make("missing"),
            actor: { _tag: "Mend" },
            body: { _tag: "Started" },
            frame: null,
          }),
        );
        expect(missing).toMatchObject({ _tag: "ScreenNotFoundError" });
      }),
    ));

  it("dates a screen's latest entry of the kinds asked for, and none for no such entry", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const screen = yield* screens.reserve({
          sessionId: yield* session(),
          workspaceId: workspace(),
        });
        expect(yield* screens.lastLoggedAt(screen.id, ["Started", "Taken"])).toBeNull();
        const started = yield* screens.append({
          screenId: screen.id,
          actor: { _tag: "Mend" },
          body: { _tag: "Started" },
          frame: null,
        });
        const connection = ViewerConnectionId.make("c-1");
        yield* screens.control(screen.id, { _tag: "Take", by: OWNER, connection }, OWNER);
        yield* screens.control(screen.id, { _tag: "Fenced", epoch: 1 }, OWNER);
        const taken = (yield* screens.log(screen.id)).at(-1);
        yield* screens.append({
          screenId: screen.id,
          actor: { _tag: "Person", userId: OWNER },
          body: { _tag: "PersonInput", clicks: 1, keys: 0, pastes: 0 },
          frame: null,
        });
        expect(taken?.body._tag).toBe("Taken");
        expect(yield* screens.lastLoggedAt(screen.id, ["Started", "Taken"])).toEqual(taken?.at);
        expect(yield* screens.lastLoggedAt(screen.id, ["Started"])).toEqual(started.at);
        expect(yield* screens.lastLoggedAt(screen.id, ["HandedBack"])).toBeNull();
        expect(yield* screens.lastLoggedAt(screen.id, [])).toBeNull();
        expect(yield* screens.lastLoggedAt(ScreenId.make("missing"), ["Started"])).toBeNull();
      }),
    ));

  it("answers a replayed call from its claim and refuses its key with other arguments", async () =>
    runFixture(({ screens, session, agentProcess }) =>
      Effect.gen(function* () {
        const sessionId = yield* session();
        const process = yield* agentProcess(sessionId);
        const screen = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        const call = { screenId: screen.id, callKey: "call-1", args: act(typing) };
        expect(yield* screens.claim(call)).toEqual({ _tag: "Claimed" });
        expect(yield* screens.claim(call)).toEqual({ _tag: "Open" });
        const settled = yield* screens.settle({
          screenId: screen.id,
          callKey: "call-1",
          outcome: "applied",
          answer: acted(process, 1),
        });
        expect(settled).toEqual({ outcome: "applied", seq: 1 });
        expect(
          yield* screens.settle({
            screenId: screen.id,
            callKey: "call-1",
            outcome: "interrupted",
            answer: acted(process, 2),
          }),
        ).toEqual(settled);
        expect(yield* screens.claim(call)).toEqual({ _tag: "Settled", call: settled });
        expect(
          yield* screens.claim({ ...call, args: act({ kind: "key", combo: "ctrl+l" }) }),
        ).toEqual({ _tag: "CallReused" });
        const [entry, ...rest] = yield* screens.log(screen.id);
        expect(rest).toEqual([]);
        expect(entry?.actor).toEqual({
          _tag: "Agent",
          processId: process,
          turnId: null,
          callKey: "call-1",
          toolCall: { _tag: "Pending" },
        });
        const missing = yield* Effect.flip(
          screens.claim({ ...call, screenId: ScreenId.make("missing") }),
        );
        expect(missing).toMatchObject({ _tag: "ScreenNotFoundError" });
      }),
    ));

  it("turns every open claim into outcome_unknown at boot", async () =>
    runFixture(({ screens, session }) =>
      Effect.gen(function* () {
        const screen = yield* screens.reserve({
          sessionId: yield* session(),
          workspaceId: workspace(),
        });
        const look = (callKey: string) =>
          screens.claim({ screenId: screen.id, callKey, args: { tool: "screen_look" } });
        yield* look("open");
        yield* look("refused");
        yield* screens.settle({
          screenId: screen.id,
          callKey: "refused",
          outcome: "refused",
          answer: null,
        });
        expect(yield* screens.boot()).toBeGreaterThanOrEqual(1);
        expect(yield* look("open")).toEqual({
          _tag: "Settled",
          call: { outcome: "outcome_unknown", seq: null },
        });
        expect(yield* look("refused")).toEqual({
          _tag: "Settled",
          call: { outcome: "refused", seq: null },
        });
        expect(yield* screens.boot()).toBe(0);
      }),
    ));
};

describe("a screen call's digest", () => {
  it("keeps a typed text's length and never its content", () => {
    const digest = screenCallDigest(act(typing));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(screenCallDigest(act({ kind: "type", text: "x".repeat(TYPED.length) }))).toBe(digest);
    expect(screenCallDigest(act({ kind: "type", text: `${TYPED}!` }))).not.toBe(digest);
    expect(screenCallDigest({ tool: "screen_look" })).not.toBe(digest);
  });

  it("reads the same arguments the same whatever their key order", () => {
    expect(
      screenCallDigest(act({ kind: "click", at: { x: 1, y: 2 }, button: "left", count: 2 })),
    ).toBe(screenCallDigest(act({ count: 2, button: "left", at: { y: 2, x: 1 }, kind: "click" })));
  });
});

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

  it("numbers concurrent appends and input changes without a gap or a repeat", async () =>
    runPostgresContract(({ screens, session }) =>
      Effect.gen(function* () {
        const screen = yield* screens.reserve({
          sessionId: yield* session(),
          workspaceId: workspace(),
        });
        const appends = Array.from({ length: 30 }, () =>
          screens.append({
            screenId: screen.id,
            actor: { _tag: "Mend" },
            body: { _tag: "Started" },
            frame: null,
          }),
        );
        const takes = Array.from({ length: 10 }, (_, n) =>
          screens.control(
            screen.id,
            n % 2 === 0
              ? { _tag: "Take", by: OWNER, connection: ViewerConnectionId.make(`c-${n}`) }
              : { _tag: "Fenced", epoch: n },
            OWNER,
          ),
        );
        yield* Effect.all([...appends, ...takes], { concurrency: "unbounded" });
        const seqs = (yield* screens.log(screen.id)).map((entry) => entry.seq);
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, n) => n + 1));
        expect(seqs.length).toBeGreaterThanOrEqual(30);
      }),
    ));

  it("writes one entry for a call settled concurrently", async () =>
    runPostgresContract(({ screens, session, agentProcess }) =>
      Effect.gen(function* () {
        const sessionId = yield* session();
        const process = yield* agentProcess(sessionId);
        const screen = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        yield* screens.claim({ screenId: screen.id, callKey: "race", args: act(typing) });
        const settled = yield* Effect.all(
          Array.from({ length: 6 }, (_, n) =>
            screens.settle({
              screenId: screen.id,
              callKey: "race",
              outcome: "applied",
              answer: acted(process, n),
            }),
          ),
          { concurrency: "unbounded" },
        );
        expect(new Set(settled.map((call) => call.seq))).toEqual(new Set([1]));
        expect(yield* screens.log(screen.id)).toHaveLength(1);
      }),
    ));

  it("links an entry to the worktree's latest checkpoint as observed after", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const screens = yield* ScreensRepo;
        const sessionId = SessionId.make(`s-${randomUUID()}`);
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-checkpoints', 'p-screens', 'checkpoints', 'checkpoints', 'mend/checkpoints',
                  ${"a".repeat(40)})`;
        yield* sql`INSERT INTO agent_sessions
            (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
          VALUES (${sessionId}, 'p-screens', 'wt-checkpoints', ${OWNER}, 'claude', 'checkpoints',
                  'mend/checkpoints', ${"a".repeat(40)}, 'running')`;
        const screen = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        const started: NewScreenLogEntry = {
          screenId: screen.id,
          actor: { _tag: "Mend" },
          body: { _tag: "Started" },
          frame: null,
        };
        expect((yield* screens.append(started)).checkpoint).toBeNull();
        for (const ordinal of [0, 1]) {
          yield* sql`INSERT INTO checkpoints (id, worktree_id, session_id, ordinal, ref, sha, trigger)
            VALUES (${`cp-${ordinal}`}, 'wt-checkpoints', ${sessionId}, ${ordinal},
                    ${`refs/mend/checkpoints/wt-checkpoints/${ordinal}`}, ${"b".repeat(40)},
                    'turn-boundary')`;
        }
        expect((yield* screens.append(started)).checkpoint).toEqual({
          _tag: "ObservedAfter",
          checkpointId: "cp-1",
        });
      }),
    ));

  it("stores no typed text in any screen row", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* postgresFixture;
        const sessionId = yield* fixture.session();
        const process = yield* fixture.agentProcess(sessionId);
        const screen = yield* fixture.screens.reserve({ sessionId, workspaceId: workspace() });
        yield* fixture.screens.claim({ screenId: screen.id, callKey: "typed", args: act(typing) });
        yield* fixture.screens.settle({
          screenId: screen.id,
          callKey: "typed",
          outcome: "applied",
          answer: acted(process, 1),
        });
        const widened: { kind: "type"; length: number; text: string } = {
          kind: "type",
          length: TYPED.length,
          text: TYPED,
        };
        yield* fixture.screens.claim({
          screenId: screen.id,
          callKey: "widened",
          args: act(typing),
        });
        yield* fixture.screens.settle({
          screenId: screen.id,
          callKey: "widened",
          outcome: "applied",
          answer: {
            processId: process,
            turnId: null,
            body: { _tag: "Acted", notes: [{ action: widened, result: "done" }] },
            frame: null,
          },
        });
        const stored = yield* sql<{ readonly row: string }>`
          SELECT row_to_json(screens)::text AS row FROM screens
          UNION ALL SELECT row_to_json(screen_log)::text FROM screen_log
          UNION ALL SELECT row_to_json(screen_calls)::text FROM screen_calls`;
        expect(
          stored.some((row) => new RegExp(`"length": ?${TYPED.length}\\b`).test(row.row)),
        ).toBe(true);
        expect(stored.filter((row) => row.row.includes(TYPED))).toEqual([]);
      }),
    ));

  it("makes forty agent entries in one turn one screen item spanning them", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { screens, session, agentProcess } = yield* postgresFixture;
        const sessionId = yield* session();
        const process = yield* agentProcess(sessionId);
        const [first, second] = [
          AgentTurnId.make(`t-${randomUUID()}`),
          AgentTurnId.make(`t-${randomUUID()}`),
        ];
        for (const [ordinal, turn] of [first, second].entries()) {
          yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status)
            VALUES (${turn}, ${sessionId}, ${process}, ${ordinal}, 'look', 'completed')`;
        }
        const screen = yield* screens.reserve({ sessionId, workspaceId: workspace() });
        const answer = (n: number, turnId: AgentTurnId | null) =>
          Effect.gen(function* () {
            const callKey = `call-${n}`;
            yield* screens.claim({ screenId: screen.id, callKey, args: act(typing) });
            yield* screens.settle({
              screenId: screen.id,
              callKey,
              outcome: "applied",
              answer: { ...acted(process, n), turnId },
            });
          });
        for (let n = 1; n <= 20; n++) yield* answer(n, first);
        const connection = ViewerConnectionId.make("c-held");
        yield* screens.control(screen.id, { _tag: "Take", by: OWNER, connection }, OWNER);
        yield* screens.control(screen.id, { _tag: "Fenced", epoch: 1 }, OWNER);
        yield* screens.control(screen.id, { _tag: "HandBack", by: OWNER }, OWNER);
        yield* screens.control(screen.id, { _tag: "Fenced", epoch: 2 }, OWNER);
        for (let n = 21; n <= 40; n++) yield* answer(n, first);
        yield* answer(41, second);
        yield* answer(42, null);

        const items = yield* sql<{
          readonly turn_id: string;
          readonly kind: string;
          readonly data: unknown;
        }>`
          SELECT turn_id, kind, data FROM agent_items
          WHERE session_id = ${sessionId} ORDER BY created_at`;
        expect(items).toEqual([
          {
            turn_id: first,
            kind: "screen",
            data: {
              span: { screenId: screen.id, fromSeq: 1, toSeq: 42 },
              actions: 40,
              frames: 40,
              coverFrameId: "frame-40",
              personHeld: true,
            },
          },
          {
            turn_id: second,
            kind: "screen",
            data: {
              span: { screenId: screen.id, fromSeq: 43, toSeq: 43 },
              actions: 1,
              frames: 1,
              coverFrameId: "frame-41",
              personHeld: false,
            },
          },
        ]);
        const typed = yield* sql<{ readonly row: string }>`
          SELECT row_to_json(agent_items)::text AS row FROM agent_items
          WHERE session_id = ${sessionId}`;
        expect(typed.filter((row) => row.row.includes(TYPED))).toEqual([]);
      }),
    ));
});
