import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { MendDBLive, ScreensRepo, ScreensRepoLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { type ScreenId, SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import type { Screen } from "@mend/domain/workbench";
import { BlobStoreFsLive } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
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
    control: (id, event, owner) =>
      Effect.gen(function* () {
        const held = event._tag === "Ended" ? holdNextEnd : null;
        if (held !== null) {
          holdNextEnd = null;
          yield* Deferred.succeed(held.reached, undefined);
          yield* Deferred.await(held.go);
        }
        return yield* stored.control(id, event, owner);
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
/** A fresh API process, with hands of its own. */
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

/** A session whose project has a screen, reserved and not yet started. */
const sessionWithScreen = Effect.gen(function* () {
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
});

describe.skipIf(postgres.skip || !dockerReady)("the Screens service, against TigerVNC Xvnc", () => {
  let xvnc: Xvnc;
  const x = (command: string) => xvnc.x(command);

  beforeAll(() => {
    xvnc = startXvnc(`mend-screens-${process.pid}-${Date.now()}`);
    world.xvncPort = xvnc.port;
  }, 660_000);

  afterAll(() => xvnc?.remove());

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
});
