import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  ScreensRepo,
  ScreensRepoLive,
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  UsersRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { SealantWorkspaceId, SessionId, SessionProcessId, ViewerConnectionId } from "@mend/domain";
import { BlobStoreFsLive, DeploymentConfig, StoreConfig } from "@mend/store";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ForwardAdapterLive } from "../src/forward.ts";
import { agentProcessRefOf } from "../src/mend-mcp/caller.ts";
import { ProofCaptures } from "../src/mend-mcp/proof-captures.ts";
import { MendMcpLive } from "../src/mend-mcp/server.ts";
import { SessionPages } from "../src/mend-mcp/session-pages.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "../src/screen/screen-workers.ts";
import { Screens, ScreensLive } from "../src/screen/screens.ts";
import {
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistryLive,
} from "../src/session-channel.ts";
import {
  SessionSocketHost,
  SessionSocketHostLive,
  type SessionSocketApi,
} from "../src/session-socket.ts";
import { startMendMcp } from "./mend-mcp-process.ts";
import { decodePng } from "./png.ts";
import { OWNER, makeScreenWorld, screenHostLayer, screenSealantLayer } from "./screen-world.ts";
import { type Xvnc, dockerReady, startXvnc } from "./xvnc.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_mcp_screens_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const scratch = mkdtempSync(path.join(tmpdir(), "mend-mcp-screens-"));
const SESSION = SessionId.make("s-mcp-screens");
const AGENT = SessionProcessId.make(crypto.randomUUID());
const SCREEN_PROCESS = SessionProcessId.make(crypto.randomUUID());
const TYPED = "a password typed on the screen";

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );

const world = makeScreenWorld();
const dbLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
);
const registry = SessionChannelRegistryLive;
const deployment = Layer.succeed(DeploymentConfig, {
  mode: "kubernetes",
  sessionEndpoint: { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
  sessionStore: "colocated",
});
const screens = ScreensLive.pipe(
  Layer.provide(screenHostLayer(world)),
  Layer.provide(ForwardAdapterLive.pipe(Layer.provide(screenSealantLayer(world)))),
  Layer.provide(BlobStoreFsLive(path.join(scratch, "blobs"))),
  Layer.provide(screenWorkersLayer(SCREEN_WORKER)),
);
/** The process that serves HTTP: one `Screens`, and Mend's MCP server asking it. */
const appLayer = Layer.mergeAll(
  SessionSocketHostLive.pipe(
    Layer.provide(StoreConfig.layerFor(path.join(scratch, "store"))),
    Layer.provide(deployment),
    Layer.provide(registry),
  ),
  SessionChannelNetworkHostLive.pipe(Layer.provide(deployment), Layer.provide(registry)),
  MendMcpLive.pipe(
    Layer.provide(registry),
    Layer.provide(Layer.mock(ProofCaptures)({})),
    Layer.provide(Layer.succeed(SessionPages, { publish: () => Effect.die("not in this test") })),
    Layer.provideMerge(screens),
    Layer.provide(UsersRepoLive),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(ScreensRepoLive, SessionProcessesRepoLive, SessionChannelTokensRepoMemory),
  ),
  Layer.provideMerge(dbLayer),
);

const refused = () => Effect.die(new Error("not in this test"));

const sessionApi = (processes: SessionProcessesRepo["Service"]): SessionSocketApi => ({
  recipes: refused,
  listServices: refused,
  runServiceRecipe: refused,
  runService: refused,
  addService: refused,
  stopService: refused,
  restartService: refused,
  stopSession: refused,
  land: refused,
  agentHook: refused,
  resourceSession: refused,
  listRepositories: refused,
  addableProjects: refused,
  addRepository: refused,
  gitTransport: refused,
  gitTransportDone: () => Effect.void,
  mcpCaller: (named) =>
    (named === null
      ? Effect.succeed(null)
      : processes.listForSession(SESSION).pipe(Effect.map((rows) => agentProcessRefOf(rows, named)))
    ).pipe(Effect.map((agentProcess) => ({ sessionId: SESSION, accountId: OWNER, agentProcess }))),
});

const Content = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
});
const Answer = Schema.Struct({
  id: Schema.Number,
  result: Schema.Struct({
    content: Schema.Array(Content),
    isError: Schema.optionalKey(Schema.Boolean),
  }),
});
const decodeAnswers = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown));
const decodeAnswer = Schema.decodeUnknownSync(Answer);

let nextId = 1;
const rpc = (method: string, params: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, params });

/** One agent's run of the staged `mend mcp` bridge, answering each tool call. */
const callsThroughBridge = (
  input: { readonly address: string; readonly token: string; readonly helper: string },
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>,
) =>
  Effect.promise(async () => {
    const bridge = startMendMcp(input.helper, {
      MEND_SESSION_ENDPOINT: `http://${input.address}`,
      MEND_SESSION_ID: SESSION,
      MEND_SESSION_TOKEN: input.token,
      MEND_AGENT_PROCESS_ID: AGENT,
    });
    bridge.send(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "2" },
      }),
    );
    bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const [at, call] of calls.entries()) {
      bridge.send(rpc("tools/call", call));
      await bridge.read(2 + at);
    }
    const run = await bridge.end();
    expect(run.code).toBe(0);
    return decodeAnswers(run.stdout)
      .slice(1)
      .map((line) => decodeAnswer(line));
  });

const textOf = (answer: typeof Answer.Type | undefined): Record<string, unknown> =>
  JSON.parse(answer?.result.content.find((block) => block.type === "text")?.text ?? "{}");

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
      yield* sql`INSERT INTO agent_sessions
          (id, project_id, worktree_id, owner_user_id, harness, worktree, branch, base_sha, status)
        VALUES (${SESSION}, 'p-screens', 'wt-screens', ${OWNER}, 'claude', 'screens',
                'mend/screens', ${"a".repeat(40)}, 'running')`;
      yield* sql`INSERT INTO session_processes
          (id, session_id, sealant_workspace_id, kind, harness, status, created_at)
        VALUES (${SCREEN_PROCESS}, ${SESSION}, 'ws-1', 'screen', NULL, 'running', now()),
               (${AGENT}, ${SESSION}, 'ws-1', 'agent-protocol', 'claude', 'running', now())`;
      yield* (yield* ScreensRepo).reserve({
        sessionId: SESSION,
        workspaceId: SealantWorkspaceId.make("ws-1"),
      });
    }).pipe(Effect.provide(Layer.provideMerge(ScreensRepoLive, dbLayer)), Effect.scoped),
  );
  world.screenProcess.set(SESSION, SCREEN_PROCESS);
}, 120_000);

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  if (!scratchCreated) return;
  await withAdmin(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`),
    ),
  );
});

describe.skipIf(postgres.skip || !dockerReady)(
  "the screen tools through the session channel and its bridge, against TigerVNC Xvnc",
  () => {
    let xvnc: Xvnc;
    const pointer = () =>
      xvnc
        .x("xdotool getmouselocation")
        .match(/x:(\d+) y:(\d+)/)
        ?.slice(1)
        .map(Number);

    beforeAll(() => {
      xvnc = startXvnc(`mend-mcp-screens-${process.pid}-${Date.now()}`);
      world.xvncPort = xvnc.port;
    }, 660_000);

    afterAll(() => xvnc?.remove());

    it("looks with an image on the wire, acts on the pointer, and names who took the screen", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const people = yield* Screens;
          const dir = yield* sockets.start(SESSION, sessionApi(yield* SessionProcessesRepo));
          const input = {
            address: network.address ?? "",
            token: yield* tokens.issue(SESSION, "launch-screens"),
            helper: path.join(dir, "bin", "mend"),
          };
          xvnc.x("xsetroot -solid '#3366cc'");

          const [look, act] = yield* callsThroughBridge(input, [
            { name: "screen_look", arguments: {} },
            {
              name: "screen_act",
              arguments: {
                actions: [
                  { kind: "move", to: { x: 321, y: 123 } },
                  { kind: "type", text: TYPED },
                ],
              },
            },
          ]);
          const image = look?.result.content[0];
          expect(image?.type).toBe("image");
          expect(image?.mimeType).toBe("image/png");
          const png = decodePng(Buffer.from(image?.data ?? "", "base64"));
          expect([png.width, png.height]).toEqual([1280, 800]);
          expect(png.at(640, 400)).toEqual([0x33, 0x66, 0xcc]);
          expect(textOf(look)).toMatchObject({
            screen: { size: "1280x800", input: "agent" },
            receipt: { seq: 1 },
            outcome: "applied",
          });
          expect(pointer()).toEqual([321, 123]);
          expect(act?.result.content.map((block) => block.type)).toEqual(["image", "text"]);
          expect(textOf(act)).toMatchObject({
            receipt: { seq: 2 },
            outcome: "applied",
            actions: [
              { action: "move 321,123", result: "done" },
              { action: `type ${TYPED.length} characters`, result: "done" },
            ],
          });
          expect(JSON.stringify(textOf(act))).not.toContain(TYPED);

          const viewer = ViewerConnectionId.make("viewer-1");
          expect(yield* people.take(SESSION, OWNER, viewer)).toMatchObject({ _tag: "Changed" });
          const [held] = yield* callsThroughBridge(input, [{ name: "screen_look", arguments: {} }]);
          expect(held?.result.isError).toBe(true);
          expect(textOf(held)).toMatchObject({
            screen: { input: { person: "Alice" } },
            refusal: "held",
            message:
              "Alice holds the screen's input. Mend sent no input; look again once they hand it back.",
          });
          yield* people.handBack(SESSION, OWNER);
          const [after] = yield* callsThroughBridge(input, [
            { name: "screen_look", arguments: {} },
          ]);
          expect(textOf(after)).toMatchObject({
            outcome: "applied",
            sinceLastLook: [
              expect.stringMatching(/^Alice took the screen at \d\d:\d\d:\d\d UTC\.$/),
              expect.stringMatching(/^Alice handed the screen back at \d\d:\d\d:\d\d UTC\.$/),
            ],
          });
        }).pipe(Effect.provide(appLayer), Effect.scoped),
      );
    }, 120_000);
  },
);
