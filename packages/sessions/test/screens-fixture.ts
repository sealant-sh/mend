/**
 * The Screens service over a scratch Postgres database and the fake screen world, shared by the
 * screen service, takeover and boot tests. Each test file gets its own database and Xvnc.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { MendDBLive, migrations, ScreensRepo, ScreensRepoLive } from "@mend/db";
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
import { Deferred, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll } from "vitest";

import { ForwardAdapterLive } from "../src/forward.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "../src/screen/screen-workers.ts";
import {
  type ScreenCallAnswer,
  type ScreenCaller,
  Screens,
  ScreensLive,
} from "../src/screen/screens.ts";
import { makeScreenWorld, OWNER, screenHostLayer, screenSealantLayer } from "./screen-world.ts";
import { startXvnc, type Xvnc } from "./xvnc.ts";

export const CONNECTION = ViewerConnectionId.make("viewer-1");

export const postgres = postgresTestConfig();
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
export interface EndHeld {
  readonly reached: Deferred.Deferred<void>;
  readonly go: Deferred.Deferred<void>;
}
let holdNextEnd: EndHeld | null = null;

/** Holds the next hand end before it settles, for a test of a look admitted meanwhile. */
export const holdNextEndWith = (held: EndHeld | null) => {
  holdNextEnd = held;
};

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

export const world = makeScreenWorld();

export const blobRoot = mkdtempSync(path.join(tmpdir(), "mend-screens-blobs-"));

const screensLayer = ScreensLive.pipe(
  Layer.provide(screenHostLayer(world)),
  Layer.provide(ForwardAdapterLive.pipe(Layer.provide(screenSealantLayer(world)))),
  Layer.provide(BlobStoreFsLive(blobRoot)),
  Layer.provide(screenWorkersLayer(SCREEN_WORKER)),
  Layer.provideMerge(reposLayer),
);

type Needs = Screens | ScreensRepo | SqlClient.SqlClient;
/** A fresh API process: its own hands, and a boot over what the last one left. */
export const asProcess = <A, E>(effect: Effect.Effect<A, E, Needs>) =>
  effect.pipe(Effect.provide(screensLayer), Effect.scoped);

export const seedSession = Effect.gen(function* () {
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
export const sessionWithScreen = Effect.gen(function* () {
  yield* (yield* SqlClient.SqlClient)`UPDATE screens SET released_at = now()
    WHERE released_at IS NULL`;
  const sessionId = yield* seedSession;
  const screen = yield* (yield* ScreensRepo).reserve({
    sessionId,
    workspaceId: SealantWorkspaceId.make(`ws-${crypto.randomUUID()}`),
  });
  return { sessionId, screen };
}).pipe(Effect.orDie);

export const agentOf = (sessionId: SessionId) => {
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

export const rowOf = (id: ScreenId) =>
  Effect.flatMap(ScreensRepo, (screens) => screens.byId(id)).pipe(
    Effect.map((screen): Screen => {
      if (screen === null) throw new Error("no screen row");
      return screen;
    }),
  );

export const logOf = (id: ScreenId) => Effect.flatMap(ScreensRepo, (screens) => screens.log(id));

export const answered = (answer: ScreenCallAnswer) => {
  if (answer._tag !== "Answered") throw new Error(`not answered: ${JSON.stringify(answer)}`);
  return answer;
};

export const movedTo = (at: { readonly x: number; readonly y: number }): ScreenAction => ({
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

/** TigerVNC Xvnc for one test file's screens: started before its tests, removed after them. */
export const useXvnc = () => {
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
  const start = (...argv: ReadonlyArray<string>) => xvnc.start(...argv);
  return { x, keysDown, pointer, start };
};
