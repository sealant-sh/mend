import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { MendDBLive, ScreensRepo, ScreensRepoLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  type ScreenId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  ViewerConnectionId,
} from "@mend/domain";
import type { Screen, ScreenAction } from "@mend/domain/workbench";
import { BlobStoreFsLive } from "@mend/store";
import { TestClock, it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { ForwardAdapterLive } from "../src/forward.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "../src/screen/screen-workers.ts";
import {
  type ScreenCallAnswer,
  type ScreenCaller,
  Screens,
  ScreensLive,
} from "../src/screen/screens.ts";
import { decodePng } from "./png.ts";
import { OWNER, makeScreenWorld, screenHostLayer, screenSealantLayer } from "./screen-world.ts";
import { type Xvnc, dockerReady, startXvnc } from "./xvnc.ts";

const CONNECTION = ViewerConnectionId.make("viewer-1");

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_screens_service_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );

const storedReposLayer = ScreensRepoLive.pipe(
  Layer.provideMerge(
    MendDBLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
    ),
  ),
);

/** Holds the next `Ended` transition at the store until the test lets it through. */
interface EndHeld {
  readonly reached: Deferred.Deferred<void>;
  readonly go: Deferred.Deferred<void>;
}
let holdNextEnd: EndHeld | null = null;

const reposLayer = Layer.effect(
  ScreensRepo,
  Effect.map(ScreensRepo, (stored): ScreensRepo["Service"] => ({
    ...stored,
    control: (id, event, owner, frame) =>
      Effect.gen(function* () {
        const held = event._tag === "Ended" ? holdNextEnd : null;
        if (held !== null) {
          holdNextEnd = null;
          yield* Deferred.succeed(held.reached, undefined);
          yield* Deferred.await(held.go);
        }
        return yield* stored.control(id, event, owner, frame);
      }),
  })),
).pipe(Layer.provideMerge(storedReposLayer));

const world = makeScreenWorld();

const blobRoot = mkdtempSync(path.join(tmpdir(), "mend-screens-blobs-"));

const screensLayer = ScreensLive.pipe(
  Layer.provide(screenHostLayer(world)),
  Layer.provide(ForwardAdapterLive.pipe(Layer.provide(screenSealantLayer(world)))),
  Layer.provide(BlobStoreFsLive(blobRoot)),
  Layer.provide(screenWorkersLayer(SCREEN_WORKER)),
  Layer.provideMerge(reposLayer),
);

type Needs = Screens | ScreensRepo | SqlClient.SqlClient;
/** A fresh API process: its own hands, and a boot over what the last one left. */
const asProcess = <A, E>(effect: Effect.Effect<A, E, Needs>) =>
  effect.pipe(Effect.provide(screensLayer), Effect.scoped);

const seedSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessionId = SessionId.make(`s-${crypto.randomUUID()}`);
  const processId = SessionProcessId.make(crypto.randomUUID());
  yield* sql`INSERT INTO agent_sessions
      (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
    VALUES (${sessionId}, 'p-screens', 'wt-screens', ${OWNER}, 'claude', 'screens', 'mend/screens',
            ${"a".repeat(40)}, 'running')`;
  yield* sql`INSERT INTO session_processes
      (id, session_id, sealant_workspace_id, kind, status, created_at)
    VALUES (${processId}, ${sessionId}, 'ws-1', 'screen', 'running', now())`;
  world.screenProcess.set(sessionId, processId);
  return sessionId;
}).pipe(Effect.orDie);

/**
 * A session whose project has a screen, reserved and not yet started. Earlier tests' screens are
 * released first, so a boot finds only this test's.
 */
const sessionWithScreen = Effect.gen(function* () {
  yield* (yield* SqlClient.SqlClient)`UPDATE screens SET released_at = now()
    WHERE released_at IS NULL`;
  const sessionId = yield* seedSession;
  const screen = yield* (yield* ScreensRepo).reserve({
    sessionId,
    workspaceId: SealantWorkspaceId.make(`ws-${crypto.randomUUID()}`),
  });
  return { sessionId, screen };
}).pipe(Effect.orDie);

const agentOf = (sessionId: SessionId) => {
  const id = SessionProcessId.make(crypto.randomUUID());
  let calls = 0;
  return {
    id,
    call: (callKey = `call-${++calls}`): ScreenCaller => ({
      sessionId,
      accountId: OWNER,
      agentProcess: { _tag: "Current", id },
      callKey,
    }),
  };
};

const rowOf = (id: ScreenId) =>
  Effect.flatMap(ScreensRepo, (screens) => screens.byId(id)).pipe(
    Effect.map((screen): Screen => {
      if (screen === null) throw new Error("no screen row");
      return screen;
    }),
  );

const logOf = (id: ScreenId) => Effect.flatMap(ScreensRepo, (screens) => screens.log(id));

const answered = (answer: ScreenCallAnswer) => {
  if (answer._tag !== "Answered") throw new Error(`not answered: ${JSON.stringify(answer)}`);
  return answer;
};

const movedTo = (at: { readonly x: number; readonly y: number }): ScreenAction => ({
  kind: "move",
  to: at,
});

let scratchCreated = false;

beforeAll(async () => {
  if (postgres.skip) return;
  await withAdmin(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`)),
  );
  scratchCreated = true;
  await Effect.runPromise(
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
    }).pipe(Effect.provide(reposLayer), Effect.scoped),
  );
}, 120_000);

afterAll(async () => {
  rmSync(blobRoot, { recursive: true, force: true });
  if (!scratchCreated) return;
  await withAdmin(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`),
    ),
  );
});

describe.skipIf(postgres.skip)("who may call, and on what", () => {
  it.live(
    "refuses a caller that names no current agent process, and a session with no screen",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          const superseded: ScreenCaller = {
            ...agent.call(),
            agentProcess: { _tag: "Superseded", id: agent.id },
          };
          expect(yield* screens.look(superseded)).toEqual({
            _tag: "Refused",
            refusal: "unattributed_caller",
          });
          for (const unattributed of [
            { ...agent.call(), agentProcess: null },
            { ...agent.call(), callKey: null },
          ]) {
            expect(yield* screens.look(unattributed)).toEqual({
              _tag: "Refused",
              refusal: "unattributed_caller",
            });
          }

          const bare = yield* seedSession;
          expect(yield* screens.look(agentOf(bare).call())).toEqual({
            _tag: "Refused",
            refusal: "no_screen",
          });
          expect(world.starts).not.toContain(sessionId);
          expect(world.starts).not.toContain(bare);
        }),
      ),
  );

  it.live("refuses a turn someone other than the screen's person sent, claiming nothing", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const sql = yield* SqlClient.SqlClient;
        const { sessionId, screen } = yield* sessionWithScreen;
        const agent = agentOf(sessionId);
        for (const accountId of ["bob", null]) {
          expect(yield* screens.look({ ...agent.call(), accountId })).toEqual({
            _tag: "Refused",
            refusal: "owner_only",
          });
        }
        const [claims] = yield* sql<{ readonly count: number }>`
          SELECT count(*)::int AS count FROM screen_calls WHERE screen_id = ${screen.id}`;
        expect(claims?.count).toBe(0);
        expect(world.starts).not.toContain(sessionId);
      }),
    ),
  );

  it.live("refuses a key no keysym names before it claims or starts anything", () =>
    asProcess(
      Effect.gen(function* () {
        const { sessionId, screen } = yield* sessionWithScreen;
        const answer = yield* (yield* Screens).act(agentOf(sessionId).call(), {
          actions: [{ kind: "key", combo: "ctrl+notakey" }],
        });
        expect(answer).toEqual({ _tag: "UnsupportedKey", key: "notakey" });
        expect(world.starts).not.toContain(sessionId);
        expect((yield* rowOf(screen.id)).life).toEqual({ _tag: "NotStarted" });
      }),
    ),
  );
});

describe.skipIf(postgres.skip)("people's input on a screen with no hand", () => {
  const takenByPerson = Effect.gen(function* () {
    const screens = yield* Screens;
    const { sessionId, screen } = yield* sessionWithScreen;
    expect(yield* screens.take(sessionId, "bob", CONNECTION)).toEqual({
      _tag: "Refused",
      why: "owner-only",
    });
    yield* screens.take(sessionId, OWNER, CONNECTION);
    expect((yield* rowOf(screen.id)).input).toMatchObject({
      _tag: "Person",
      connection: CONNECTION,
    });
    return { screens, sessionId, screen };
  });

  it.effect("hands a paused screen back to the agent once two minutes pass", () =>
    asProcess(
      Effect.gen(function* () {
        const { screens, sessionId, screen } = yield* takenByPerson;
        yield* screens.lapse(sessionId, CONNECTION, "disconnected");
        expect((yield* rowOf(screen.id)).input).toMatchObject({
          _tag: "Paused",
          reason: "disconnected",
        });
        yield* TestClock.adjust("119 seconds");
        expect((yield* rowOf(screen.id)).input._tag).toBe("Paused");
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        for (let turn = 0; (yield* rowOf(screen.id)).input._tag === "Paused"; turn++) {
          if (turn > 100) throw new Error("never handed back");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        }
        expect((yield* rowOf(screen.id)).input._tag).toBe("AwaitingAgent");
        const last = (yield* logOf(screen.id)).at(-1);
        expect([last?.actor, last?.body._tag]).toEqual([{ _tag: "Mend" }, "HandedBack"]);
      }),
    ),
  );

  it.effect("keeps the holder while heartbeats come, and pauses once one is ten seconds late", () =>
    asProcess(
      Effect.gen(function* () {
        const { screens, sessionId, screen } = yield* takenByPerson;
        yield* TestClock.adjust("8 seconds");
        expect(yield* screens.heartbeat(sessionId, CONNECTION)).toBe(true);
        expect(yield* screens.heartbeat(sessionId, ViewerConnectionId.make("other"))).toBe(false);
        yield* TestClock.adjust("8 seconds");
        expect((yield* rowOf(screen.id)).input._tag).toBe("Person");
        yield* TestClock.adjust("3 seconds");
        for (let turn = 0; (yield* rowOf(screen.id)).input._tag === "Person"; turn++) {
          if (turn > 100) throw new Error("never paused");
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
        }
        expect((yield* rowOf(screen.id)).input).toMatchObject({
          _tag: "Paused",
          reason: "lease-lapsed",
        });
      }),
    ),
  );
});

describe.skipIf(postgres.skip || !dockerReady)("the Screens service, against TigerVNC Xvnc", () => {
  let xvnc: Xvnc;
  const x = (command: string) => xvnc.x(command);
  const keysDown = () => (x('xinput query-state "TigerVNC keyboard"').match(/=down/g) ?? []).length;
  const pointer = () =>
    x("xdotool getmouselocation")
      .match(/x:(\d+) y:(\d+)/)
      ?.slice(1)
      .map(Number);

  beforeAll(() => {
    xvnc = startXvnc(`mend-screens-${process.pid}-${Date.now()}`);
    world.xvncPort = xvnc.port;
    world.signWith = ({ full, viewOnly }) =>
      xvnc.signWith(Redacted.value(full), Redacted.value(viewOnly));
  }, 660_000);

  afterAll(() => {
    world.signWith = null;
    xvnc?.remove();
  });

  it.live(
    "looks: the screen started on demand, its frame stored, the receipt returned, a retry answered from the store",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          x("xsetroot -solid '#3366cc'");
          const look = answered(yield* screens.look(agent.call("look-1")));
          expect(world.starts).toContain(sessionId);
          expect(look.outcome).toBe("applied");
          expect(decodePng(look.png).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);
          expect(look.receipt).toEqual({ screenId: screen.id, seq: 1, callKey: "look-1" });
          const [entry] = yield* logOf(screen.id);
          expect([entry?.actor._tag, entry?.body._tag]).toEqual(["Agent", "Looked"]);
          expect(entry?.frame?.id).toBe(look.frameId);
          const stored = path.join(
            blobRoot,
            "screen-frames",
            screen.id,
            `${entry?.frame?.digest}.png`,
          );
          expect(decodePng(readFileSync(stored)).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);

          x("xsetroot -solid '#cc3300'");
          const again = answered(yield* screens.look(agent.call("look-1")));
          expect(again.receipt).toEqual(look.receipt);
          expect(decodePng(again.png).at(640, 400)).toEqual([0x33, 0x66, 0xcc]);
          expect((yield* logOf(screen.id)).length).toBe(1);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "acts: the batch runs on the screen, its notes and receipt answered",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call("look-1"));
          const acted = answered(
            yield* screens.act(agent.call("act-1"), { actions: [movedTo({ x: 321, y: 123 })] }),
          );
          expect(pointer()).toEqual([321, 123]);
          expect(acted.outcome).toBe("applied");
          expect(acted.receipt).toEqual({ screenId: screen.id, seq: 2, callKey: "act-1" });
          expect(acted.actions).toEqual([{ action: movedTo({ x: 321, y: 123 }), result: "done" }]);
          expect(acted.frameId).not.toBeNull();
          const entry = (yield* logOf(screen.id)).at(-1);
          expect(entry?.actor).toEqual({
            _tag: "Agent",
            processId: agent.id,
            turnId: null,
            callKey: "act-1",
            toolCall: { _tag: "Pending" },
          });
          expect(entry?.body._tag).toBe("Acted");
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "refuses an act on a turn someone other than the screen's person sent, sending nothing",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          answered(yield* screens.look(agent.call()));
          x("xdotool mousemove 17 19");
          const seen = (yield* logOf(screen.id)).length;
          const steered = { ...agent.call(), accountId: "bob" };
          expect(yield* screens.act(steered, { actions: [movedTo({ x: 777, y: 555 })] })).toEqual({
            _tag: "Refused",
            refusal: "owner_only",
          });
          expect(pointer()).toEqual([17, 19]);
          expect((yield* logOf(screen.id)).length).toBe(seen);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "resets the input when the hand's connection ends, and dials a new hand at the next call",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          answered(yield* screens.look(agent.call()));
          expect((yield* rowOf(screen.id)).input._tag).toBe("Agent");
          const dialled = world.dials.length;
          world.sockets.at(-1)?.destroy();
          for (let waited = 0; (yield* rowOf(screen.id)).input._tag === "Agent"; waited++) {
            if (waited > 100) throw new Error("the input never reset");
            yield* Effect.sleep("20 millis");
          }
          expect((yield* rowOf(screen.id)).input._tag).toBe("AwaitingAgent");
          answered(yield* screens.look(agent.call()));
          expect(world.dials.length).toBe(dialled + 1);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live("answers a retry after the screen stopped from its claim, starting nothing", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const repo = yield* ScreensRepo;
        const { sessionId, screen } = yield* sessionWithScreen;
        const caller = agentOf(sessionId).call("before-idle-stop");
        const first = answered(yield* screens.look(caller));
        yield* repo.setLife(screen.id, { life: { _tag: "Ended", reason: "idle" } });
        const starts = world.starts.length;
        expect(answered(yield* screens.look(caller)).receipt).toEqual(first.receipt);
        expect(world.starts.length).toBe(starts);
      }),
    ),
  );

  it.live("keeps a look on a new hand admitted while the old hand's end was still settling", () =>
    asProcess(
      Effect.gen(function* () {
        const screens = yield* Screens;
        const { sessionId, screen } = yield* sessionWithScreen;
        const agent = agentOf(sessionId);
        answered(yield* screens.look(agent.call()));
        const held: EndHeld = {
          reached: yield* Deferred.make<void>(),
          go: yield* Deferred.make<void>(),
        };
        holdNextEnd = held;
        world.sockets.at(-1)?.destroy();
        yield* Deferred.await(held.reached);
        const dialled = yield* Deferred.make<void>();
        world.onDial = () => Deferred.doneUnsafe(dialled, Effect.void);
        const looking = yield* Effect.forkChild(screens.look(agent.call()));
        yield* Deferred.await(dialled);
        world.onDial = null;
        yield* Deferred.succeed(held.go, undefined);
        expect(answered(yield* Fiber.join(looking)).outcome).toBe("applied");
        expect((yield* rowOf(screen.id)).input._tag).toBe("Agent");
      }),
    ),
  );

  it.live(
    "answers a retry from its claim with no input, and refuses its key reused for other arguments",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call());
          const params = { actions: [movedTo({ x: 400, y: 300 })] };
          const first = answered(yield* screens.act(agent.call("retried"), params));
          x("xdotool mousemove 5 5");
          const again = answered(yield* screens.act(agent.call("retried"), params));
          expect(pointer()).toEqual([5, 5]);
          expect(again.receipt).toEqual(first.receipt);
          expect(again.actions).toEqual(first.actions);
          expect(decodePng(again.png).width).toBe(1280);
          expect(
            yield* screens.act(agent.call("retried"), { actions: [movedTo({ x: 9, y: 9 })] }),
          ).toEqual({ _tag: "Refused", refusal: "call_reused" });
          expect(pointer()).toEqual([5, 5]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "answers a second batch busy while one runs, and a look waits for it",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call());
          const running = yield* Effect.forkChild(
            screens.act(agent.call(), {
              actions: [{ kind: "wait", ms: 1_500 }, movedTo({ x: 600, y: 500 })],
            }),
          );
          yield* Effect.sleep("300 millis");
          expect(
            yield* screens.act(agent.call(), { actions: [movedTo({ x: 10, y: 10 })] }),
          ).toEqual({ _tag: "Refused", refusal: "busy" });
          const looked = answered(yield* screens.look(agent.call()));
          expect(pointer()).toEqual([600, 500]);
          const batch = answered(yield* Fiber.join(running));
          expect(looked.receipt.seq).toBeGreaterThan(batch.receipt.seq);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "stops a batch at a take, holds no key after it, and makes the agent look first once handed back",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          const agent = agentOf(sessionId);
          yield* screens.look(agent.call());
          const running = yield* Effect.forkChild(
            screens.act(agent.call(), {
              actions: [
                { kind: "type", text: "a".repeat(400) },
                { kind: "wait", ms: 3_000 },
                movedTo({ x: 700, y: 700 }),
              ],
            }),
          );
          yield* Effect.sleep("200 millis");
          yield* screens.take(sessionId, OWNER, CONNECTION);
          const batch = answered(yield* Fiber.join(running));
          expect(batch.outcome).toBe("interrupted");
          expect(batch.actions.map((note) => note.result).at(-1)).toBe("skipped: taken over");
          expect(keysDown()).toBe(0);
          expect(pointer()).not.toEqual([700, 700]);
          expect((yield* rowOf(screen.id)).input).toMatchObject({
            _tag: "Person",
            connection: CONNECTION,
          });
          expect(yield* screens.look(agent.call())).toEqual({ _tag: "Refused", refusal: "held" });

          yield* screens.handBack(sessionId, OWNER);
          expect((yield* rowOf(screen.id)).input._tag).toBe("AwaitingAgent");
          expect(yield* screens.act(agent.call(), { actions: [movedTo({ x: 1, y: 1 })] })).toEqual({
            _tag: "Refused",
            refusal: "look_first",
          });
          const looked = answered(yield* screens.look(agent.call()));
          expect(looked.sinceLastLook.map((entry) => entry.body._tag)).toEqual([
            "Taken",
            "HandedBack",
          ]);
          for (const entry of looked.sinceLastLook) expect(entry.frame).not.toBeNull();
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "pauses a holder whose heartbeat stops, and releases the key it held",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          yield* screens.look(agentOf(sessionId).call());
          yield* screens.take(sessionId, OWNER, CONNECTION);
          expect(
            yield* screens.input(sessionId, CONNECTION, [
              { _tag: "Key", down: true, keysym: 0xffe1 },
            ]),
          ).toBe(true);
          expect(keysDown()).toBe(1);
          for (let waited = 0; (yield* rowOf(screen.id)).input._tag === "Person"; waited++) {
            if (waited > 150) throw new Error("never paused");
            yield* Effect.sleep("100 millis");
          }
          expect((yield* rowOf(screen.id)).input).toMatchObject({
            _tag: "Paused",
            reason: "lease-lapsed",
          });
          expect(keysDown()).toBe(0);
          const paused = (yield* logOf(screen.id)).at(-1);
          expect(paused?.body).toEqual({ _tag: "Paused", reason: "lease-lapsed" });
          expect(paused?.frame).not.toBeNull();
          expect(
            yield* screens.input(sessionId, CONNECTION, [
              { _tag: "Key", down: true, keysym: 0xffe1 },
            ]),
          ).toBe(false);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "boots a claim stored without its outcome into outcome_unknown, sending its input never again",
    () =>
      Effect.gen(function* () {
        const crashed = yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            const { sessionId, screen } = yield* sessionWithScreen;
            const agent = agentOf(sessionId);
            yield* screens.look(agent.call());
            const params = { actions: [movedTo({ x: 222, y: 111 })] };
            yield* (yield* ScreensRepo).claim({
              screenId: screen.id,
              callKey: "crashed",
              args: { tool: "screen_act", params },
            });
            return { sessionId, screen, agent, params };
          }),
        );
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            x("xdotool mousemove 7 7");
            expect(yield* screens.act(crashed.agent.call("crashed"), crashed.params)).toEqual({
              _tag: "NoEntry",
              outcome: "outcome_unknown",
            });
            expect(pointer()).toEqual([7, 7]);
            expect(
              yield* screens.act(crashed.agent.call(), { actions: [movedTo({ x: 1, y: 1 })] }),
            ).toEqual({ _tag: "Refused", refusal: "look_first" });
            expect((yield* rowOf(crashed.screen.id)).input._tag).toBe("AwaitingAgent");
            expect(world.starts.filter((started) => started === crashed.sessionId).length).toBe(1);
          }),
        );
      }),
    { timeout: 60_000 },
  );

  it.live(
    "boots a fence committed without its acknowledgement into Paused",
    () =>
      Effect.gen(function* () {
        const fenced = yield* asProcess(
          Effect.gen(function* () {
            const { sessionId, screen } = yield* sessionWithScreen;
            yield* (yield* Screens).look(agentOf(sessionId).call());
            yield* (yield* ScreensRepo).control(
              screen.id,
              { _tag: "Take", by: OWNER, connection: CONNECTION },
              OWNER,
            );
            expect((yield* rowOf(screen.id)).input._tag).toBe("Fencing");
            return { sessionId, screen };
          }),
        );
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            x("xsetroot -solid '#55aa33'");
            expect(yield* screens.heartbeat(fenced.sessionId, CONNECTION)).toBe(false);
            const row = yield* rowOf(fenced.screen.id);
            expect(row.input).toMatchObject({ _tag: "Paused", reason: "restart" });
            expect(row.input.epoch).toBe(3);
            const last = (yield* logOf(fenced.screen.id)).at(-1);
            expect(last?.body).toEqual({ _tag: "Paused", reason: "restart" });
            if (last?.frame == null) throw new Error("the restart's pause kept no frame");
            const stored = path.join(
              blobRoot,
              "screen-frames",
              fenced.screen.id,
              `${last.frame.digest}.png`,
            );
            expect(decodePng(readFileSync(stored)).at(640, 400)).toEqual([0x55, 0xaa, 0x33]);
            expect(keysDown()).toBe(0);
          }),
        );
      }),
    { timeout: 60_000 },
  );

  it.live(
    "takes over a screen that outlived Mend, signed for again rather than started over, and moves its pointer",
    () =>
      Effect.gen(function* () {
        const before = yield* asProcess(
          Effect.gen(function* () {
            const { sessionId, screen } = yield* sessionWithScreen;
            answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
            return { sessionId, screen };
          }),
        );
        yield* asProcess(
          Effect.gen(function* () {
            const screens = yield* Screens;
            const viewer = ViewerConnectionId.make("viewer-after-restart");
            yield* screens.take(before.sessionId, OWNER, viewer);
            expect((yield* rowOf(before.screen.id)).input).toMatchObject({
              _tag: "Person",
              connection: viewer,
            });
            const moved = yield* screens.input(before.sessionId, viewer, [
              { _tag: "Pointer", buttons: 0, x: 444, y: 333 },
            ]);
            expect(moved).toBe(true);
            expect(pointer()).toEqual([444, 333]);
            expect(world.rekeys).toContain(before.sessionId);
            expect(world.starts.filter((started) => started === before.sessionId)).toHaveLength(1);
          }),
        );
      }),
    { timeout: 60_000 },
  );
});
