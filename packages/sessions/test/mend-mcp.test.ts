import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  SessionChannelTokensRepo,
  SessionChannelTokensRepoMemory,
  SessionPagesRepoLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  UsersRepo,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { PAGE_LIMITS, PAGE_REQUEST_MAX_BYTES } from "@mend/domain/workbench";
import { DeploymentConfig, StoreConfig } from "@mend/store";
import { type Duration, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentProcessRefOf,
  MEND_MCP_CALL_KEY_HEADER,
  MEND_MCP_PATH,
  McpCallerUnavailableError,
} from "../src/mend-mcp/caller.ts";
import { ProofCaptures } from "../src/mend-mcp/proof-captures.ts";
import { MendMcp, MendMcpLive, mendMcpLayer } from "../src/mend-mcp/server.ts";
import { PAGE_CHECK_WORKER, sessionPagesLayer } from "../src/mend-mcp/session-pages.ts";
import { MEND_TOOLKITS } from "../src/mend-mcp/toolkits.ts";
import { Screens } from "../src/screen/screens.ts";
import {
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
  MAX_BODY_BYTES,
} from "../src/session-channel.ts";
import {
  SessionSocketHost,
  SessionSocketHostLive,
  type SessionSocketApi,
} from "../src/session-socket.ts";
import { startMendMcp } from "./mend-mcp-process.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_mcp_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-mcp-test-"));

const PROJECT = ProjectId.make("p-mcp");
const WORKTREE = WorktreeId.make("wt-mcp");
const ALICE_SESSION = SessionId.make("s-mcp-alice");
const BEN_SESSION = SessionId.make("s-mcp-ben");
const ownerOf = (id: SessionId) => (id === ALICE_SESSION ? "alice" : "ben");

const dbLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
);
const registry = SessionChannelRegistryLive;
const deployment = Layer.succeed(DeploymentConfig, {
  mode: "kubernetes",
  sessionEndpoint: { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
  sessionStore: "colocated",
});
const channelLayer = (options: { readonly idle?: Duration.Input } = {}) =>
  Layer.mergeAll(
    SessionSocketHostLive.pipe(
      Layer.provide(StoreConfig.layerFor(storeRoot)),
      Layer.provide(deployment),
      Layer.provide(registry),
    ),
    SessionChannelNetworkHostLive.pipe(
      Layer.provide(deployment),
      Layer.provide(registry),
      Layer.provide(SessionChannelTokensRepoMemory),
    ),
    SessionChannelTokensRepoMemory,
    SessionProcessesRepoLive,
    (options.idle === undefined ? MendMcpLive : mendMcpLayer(MEND_TOOLKITS, options)).pipe(
      Layer.provide(sessionPagesLayer(PAGE_CHECK_WORKER)),
      Layer.provide(SessionPagesRepoLive),
      Layer.provide(registry),
      // The screen tools' own tests drive a real `Screens` (`mend-mcp-screens.test.ts`).
      Layer.provide(Layer.mock(ProofCaptures)({})),
      Layer.provide(Layer.mock(Screens)({})),
      Layer.provide(Layer.mock(UsersRepo)({})),
    ),
    registry,
  ).pipe(Layer.provideMerge(dbLayer));

const refused = () => Effect.die(new Error("not in this test"));

const sessionApi = (
  sessionId: SessionId,
  processes: SessionProcessesRepo["Service"],
): SessionSocketApi => ({
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
      : processes
          .listForSession(sessionId)
          .pipe(Effect.map((rows) => agentProcessRefOf(rows, named)))
    ).pipe(
      Effect.map((agentProcess) => ({ sessionId, accountId: ownerOf(sessionId), agentProcess })),
    ),
});

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly mcpSession: string | null;
  readonly body: unknown;
}

const post = async (
  address: string,
  token: string,
  message: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> => {
  const response = await fetch(`http://${address}${MEND_MCP_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    mcpSession: response.headers.get("mcp-session-id"),
    body: text === "" ? null : JSON.parse(text),
  };
};

let nextId = 1;
const rpc = (method: string, params: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, params });

const connect = async (address: string, token: string) => {
  const init = await post(
    address,
    token,
    rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mend-mcp-test", version: "0" },
    }),
  );
  expect(init.status).toBe(200);
  const mcpSession = init.mcpSession;
  if (mcpSession === null) throw new Error("initialize answered no Mcp-Session-Id");
  const headers = { "mcp-session-id": mcpSession, "mcp-protocol-version": "2025-06-18" };
  const initialized = await post(
    address,
    token,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    headers,
  );
  expect(initialized).toMatchObject({ status: 202, body: null });
  return {
    init,
    mcpSession,
    call: (method: string, params: unknown, extra: Record<string, string> = {}) =>
      post(address, token, rpc(method, params), { ...headers, ...extra }),
    render: (args: unknown, callKey: string, extra: Record<string, string> = {}) =>
      post(address, token, rpc("tools/call", { name: "html_render", arguments: args }), {
        ...headers,
        [MEND_MCP_CALL_KEY_HEADER]: callKey,
        ...extra,
      }),
  };
};

const CallResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  structuredContent: Schema.optional(
    Schema.Struct({
      htmlRender: Schema.Struct({
        attachmentId: Schema.String,
        title: Schema.String,
        height: Schema.Number,
      }),
      message: Schema.String,
    }),
  ),
});
const decodeResult = Schema.decodeUnknownSync(Schema.Struct({ result: CallResult }));
const decodeAny = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }));

const resultOf = (answer: Answer) => decodeResult(answer.body).result;
const failureOf = (answer: Answer) => {
  const result = resultOf(answer);
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]?.text ?? "null");
};

const pageRows = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      id: string;
      session_id: string;
      account_id: string | null;
      call_key: string;
      title: string;
      height: number;
      html: string;
    }>`SELECT id, session_id, account_id, call_key, title, height, html FROM session_pages ORDER BY published_at`;
  });

const withChannel = <A>(
  test: (input: {
    readonly address: string;
    readonly tokens: { readonly alice: string; readonly ben: string };
    readonly helper: string;
    readonly mcpSessions: ReadonlyArray<string>;
    readonly rows: () => Promise<ReadonlyArray<Record<string, unknown>>>;
    readonly sql: (statement: string) => Promise<unknown>;
    readonly relaunchAlice: () => Promise<void>;
  }) => Promise<A>,
  options: {
    readonly aliceApi?: (base: SessionSocketApi) => SessionSocketApi;
    readonly idle?: Duration.Input;
  } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const network = yield* SessionChannelNetworkHost;
        const sockets = yield* SessionSocketHost;
        const tokens = yield* SessionChannelTokensRepo;
        const mendMcp = yield* MendMcp;
        const processes = yield* SessionProcessesRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM session_pages`;
        const mcpSessions: Array<string> = [];
        (yield* SessionChannelRegistry).serveMcp({
          ...mendMcp,
          handle: (request, caller) => {
            const named = request.headers.get("mcp-session-id");
            if (
              caller.sessionId === ALICE_SESSION &&
              named !== null &&
              !mcpSessions.includes(named)
            ) {
              mcpSessions.push(named);
            }
            return mendMcp.handle(request, caller);
          },
        });
        const alicesApi = sessionApi(ALICE_SESSION, processes);
        const aliceApi = options.aliceApi?.(alicesApi) ?? alicesApi;
        const dir = yield* sockets.start(ALICE_SESSION, aliceApi);
        yield* sockets.start(BEN_SESSION, sessionApi(BEN_SESSION, processes));
        const alice = yield* tokens.issue(ALICE_SESSION, "launch-alice");
        const ben = yield* tokens.issue(BEN_SESSION, "launch-ben");
        const context = yield* Effect.context<SqlClient.SqlClient>();
        return yield* Effect.promise(() =>
          test({
            address: network.address ?? "",
            tokens: { alice, ben },
            helper: path.join(dir, "bin", "mend"),
            mcpSessions,
            rows: () => Effect.runPromise(pageRows().pipe(Effect.provide(context))),
            sql: (statement) => Effect.runPromise(sql.unsafe(statement)),
            relaunchAlice: () =>
              Effect.runPromise(
                sockets
                  .stop(ALICE_SESSION)
                  .pipe(Effect.andThen(sockets.start(ALICE_SESSION, aliceApi)), Effect.asVoid),
              ),
          }),
        );
      }).pipe(Effect.provide(channelLayer(options))),
    ),
  );

const PAGE = {
  html: "<!doctype html><style>.bar{height:24px}</style><div class=bar>p99 · 41 ms</div>",
  title: "Latency by region",
  height: 420,
};

describe.skipIf(postgres.skip)("Mend's MCP server over the session channel", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'mcp', '/store/p-mcp/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-mcp', 'wt-mcp', 'mend/wt-mcp', 'abc')`;
        for (const id of [ALICE_SESSION, BEN_SESSION]) {
          yield* (yield* SessionsRepo).create({
            id,
            projectId: PROJECT,
            worktreeId: WORKTREE,
            harness: "claude",
            label: null,
            worktree: "wt-mcp",
            branch: "mend/wt-mcp",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            contextSnapshotId: null,
            ownerUserId: ownerOf(id),
            origin: "mend",
          });
        }
      }).pipe(Effect.provide(SessionsRepoLive.pipe(Layer.provideMerge(dbLayer))), Effect.scoped),
    );
  }, 60_000);

  afterAll(async () => {
    fs.rmSync(storeRoot, { recursive: true, force: true });
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
  });

  it("initializes, lists html_render on t3code's contract, and publishes a page as the token's session", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const client = await connect(address, tokens.alice);
      expect(client.init.contentType).toContain("application/json");
      expect(decodeAny(client.init.body).result).toMatchObject({ serverInfo: { name: "mend" } });

      const list = await client.call("tools/list", {});
      expect(decodeAny(list.body).result).toMatchObject({
        tools: [
          {
            name: "html_render",
            inputSchema: {
              type: "object",
              required: expect.arrayContaining(["html", "title", "height"]),
              properties: {
                html: { type: "string", maxLength: PAGE_LIMITS.htmlChars },
                title: { type: "string", maxLength: PAGE_LIMITS.titleChars },
                height: { type: "integer" },
              },
            },
            annotations: { readOnlyHint: true },
          },
          { name: "screen_look" },
          { name: "screen_act" },
          { name: "proof_screenshot" },
          { name: "proof_missing" },
        ],
      });
      expect(decodeAny(list.body).result).toMatchObject({ tools: { length: 5 } });

      const published = resultOf(await client.render(PAGE, "call-1"));
      expect(published.isError).toBe(false);
      const reference = published.structuredContent?.htmlRender;
      expect(reference).toMatchObject({ title: PAGE.title, height: PAGE.height });
      expect(published.structuredContent?.message).toContain(
        "Shown to the reader above your reply",
      );
      expect(JSON.parse(published.content[0]?.text ?? "null")).toEqual(published.structuredContent);
      expect(await rows()).toEqual([
        {
          id: reference?.attachmentId,
          session_id: ALICE_SESSION,
          account_id: "alice",
          call_key: "call-1",
          title: PAGE.title,
          height: PAGE.height,
          html: PAGE.html,
        },
      ]);
    });
  });

  it("publishes each concurrent caller as itself, whatever MCP session or arguments it names", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const alice = await connect(address, tokens.alice);
      await connect(address, tokens.ben);
      const asBen = (title: string) =>
        post(
          address,
          tokens.ben,
          rpc("tools/call", {
            name: "html_render",
            arguments: { ...PAGE, title, sessionId: ALICE_SESSION, accountId: "alice" },
          }),
          {
            "mcp-session-id": alice.mcpSession,
            "mcp-protocol-version": "2025-06-18",
            [MEND_MCP_CALL_KEY_HEADER]: `ben-${title}`,
          },
        );
      const answers = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          index % 2 === 0
            ? alice.render({ ...PAGE, title: `a${index}` }, `alice-a${index}`)
            : asBen(`b${index}`),
        ),
      );
      for (const answer of answers) expect(resultOf(answer).isError).toBe(false);
      const stored = await rows();
      expect(
        stored.map((row) => [row["title"], row["session_id"], row["account_id"]]).toSorted(),
      ).toEqual([
        ["a0", ALICE_SESSION, "alice"],
        ["a2", ALICE_SESSION, "alice"],
        ["b1", BEN_SESSION, "ben"],
        ["b3", BEN_SESSION, "ben"],
      ]);
    });
  });

  it("answers a retried call with its first page, once, and refuses its key on another page", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const client = await connect(address, tokens.alice);
      const first = resultOf(await client.render(PAGE, "retried"));
      const again = await Promise.all([
        client.render(PAGE, "retried"),
        client.render(PAGE, "retried"),
      ]);
      for (const answer of again) {
        expect(resultOf(answer).structuredContent?.htmlRender).toEqual(
          first.structuredContent?.htmlRender,
        );
      }
      expect(await rows()).toHaveLength(1);
      const reused = failureOf(await client.render({ ...PAGE, html: "<p>another</p>" }, "retried"));
      expect(reused).toMatchObject({
        _tag: "MendMcpFailure",
        code: "call_reused",
      });
      expect(await rows()).toHaveLength(1);
    });
  });

  it("returns a viewport-height page and a local file as failed results, and clamps the height", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const client = await connect(address, tokens.alice);
      const tall = failureOf(
        await client.render(
          { ...PAGE, html: "<style>main{min-height:100vh}</style><main>x</main>" },
          "vh",
        ),
      );
      expect(tall).toMatchObject({
        _tag: "MendMcpFailure",
        code: "invalid_request",
        message: expect.stringContaining("viewport height unit (100vh)"),
      });
      const local = failureOf(
        await client.render({ ...PAGE, html: '<img src="/workspace/repo/shot.png">' }, "image"),
      );
      expect(local).toMatchObject({
        code: "invalid_request",
        message: expect.stringMatching(/\/workspace\/repo\/shot\.png.*data: URI/),
      });
      const fine = resultOf(
        await client.render(
          {
            ...PAGE,
            html: '<p>use 100vh sparingly</p><img src="data:image/png;base64,AAAA">',
            height: 9000,
          },
          "fine",
        ),
      );
      expect(fine.structuredContent?.htmlRender.height).toBe(PAGE_LIMITS.maxHeight);
      expect((await rows()).map((row) => row["call_key"])).toEqual(["fine"]);
    });
  });

  it("refuses the pages the merge gate stored, a local stylesheet and an entity-encoded vh, and stores neither", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const client = await connect(address, tokens.alice);
      const stylesheet = failureOf(
        await client.render(
          { ...PAGE, html: '<link rel="stylesheet" href="/tmp/review.css"><main>x</main>' },
          "gate-link",
        ),
      );
      expect(stylesheet).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("/tmp/review.css"),
      });
      const encoded = failureOf(
        await client.render(
          { ...PAGE, html: '<main style="height:100&#118;h">x</main>' },
          "gate-vh",
        ),
      );
      expect(encoded).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("viewport height unit (100vh)"),
      });
      expect(await rows()).toEqual([]);
    });
  });

  it("returns a database outage as a failed result the agent can try again", async () => {
    await withChannel(async ({ address, tokens, rows, sql }) => {
      const client = await connect(address, tokens.alice);
      await sql("ALTER TABLE session_pages RENAME TO session_pages_away");
      try {
        expect(failureOf(await client.render(PAGE, "outage"))).toMatchObject({
          _tag: "MendMcpFailure",
          code: "storage_unavailable",
          message: expect.stringContaining("Call the tool again"),
        });
      } finally {
        await sql("ALTER TABLE session_pages_away RENAME TO session_pages");
      }
      resultOf(await client.render(PAGE, "outage"));
      expect(await rows()).toHaveLength(1);
    });
  });

  it("refuses a NUL character as the agent's to fix, and a session Mend no longer has as final", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const client = await connect(address, tokens.alice);
      expect(
        failureOf(await client.render({ ...PAGE, html: "<p>a\u0000b</p>" }, "nul")),
      ).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("U+0000"),
      });
      expect(await rows()).toEqual([]);
    });
    await withChannel(
      async ({ address, tokens, rows }) => {
        const client = await connect(address, tokens.alice);
        const gone = failureOf(await client.render(PAGE, "gone"));
        expect(gone).toMatchObject({ code: "session_not_found" });
        expect(gone.message).not.toContain("again");
        expect(await rows()).toEqual([]);
      },
      {
        aliceApi: (base) => ({
          ...base,
          mcpCaller: () =>
            Effect.succeed({
              sessionId: SessionId.make("s-mcp-gone"),
              accountId: "alice",
              agentProcess: null,
            }),
        }),
      },
    );
  });

  it("refuses a page whose markup outlasts the check's deadline, and answers other sessions while it is checked", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const alice = await connect(address, tokens.alice);
      const ben = await connect(address, tokens.ben);
      const nested = "<div>".repeat(102_000);
      expect(nested.length).toBeLessThan(PAGE_LIMITS.htmlChars);
      const started = performance.now();
      const rendering = alice.render({ ...PAGE, html: nested }, "nested");
      for (let probe = 1; probe <= 3; probe++) {
        const due = started + probe * 300;
        await new Promise((resolve) => setTimeout(resolve, due - performance.now()));
        const status = await ben.call("tools/list", {}).then((answer) => answer.status, String);
        expect(performance.now() - due).toBeLessThan(250);
        expect(status).toBe(200);
      }
      const refusal = failureOf(await rendering);
      expect(performance.now() - started).toBeLessThan(4_000);
      expect(refusal).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("took too long to check"),
      });
      expect(await rows()).toEqual([]);
      expect(resultOf(await alice.render(PAGE, "after")).isError).toBe(false);
    });
  }, 60_000);

  it("reads a page-sized body on this route only, and refuses one past the cap", async () => {
    await withChannel(async ({ address, tokens, rows }) => {
      const client = await connect(address, tokens.alice);
      const big = "x".repeat(PAGE_LIMITS.htmlChars - 100);
      const published = resultOf(await client.render({ ...PAGE, html: big }, "big"));
      expect(published.isError).toBe(false);
      const tooBig = await post(address, tokens.alice, "x".repeat(PAGE_REQUEST_MAX_BYTES + 1), {
        "mcp-session-id": client.mcpSession,
      });
      expect(tooBig.status).toBe(413);
      expect(await rows()).toHaveLength(1);
    });
  });

  it("the staged helper's mend mcp publishes as the session, and carries on after Mend forgets its MCP session", async () => {
    await withChannel(async ({ address, tokens, helper, rows, mcpSessions }) => {
      const harness = startMendMcp(helper, {
        MEND_SESSION_ENDPOINT: `http://${address}`,
        MEND_SESSION_ID: ALICE_SESSION,
        MEND_SESSION_TOKEN: tokens.alice,
      });
      harness.send(
        rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-code", version: "2" },
        }),
      );
      harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      harness.send(rpc("tools/call", { name: "html_render", arguments: PAGE }));
      await harness.read(2);
      const ended = await fetch(`http://${address}${MEND_MCP_PATH}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${tokens.alice}`,
          "mcp-session-id": mcpSessions.at(-1) ?? "",
        },
      });
      expect(ended.status).toBe(204);
      harness.send(
        rpc("tools/call", { name: "html_render", arguments: { ...PAGE, title: "Again" } }),
      );
      const run = await harness.end();
      expect(run.code).toBe(0);
      expect(run.stdout).toHaveLength(3);
      expect(run.stderr).toContain("Mend had forgotten this MCP session; started it again");
      expect(run.stdout[0]).toMatchObject({ result: { serverInfo: { name: "mend" } } });
      for (const answer of run.stdout.slice(1)) {
        expect(answer).toMatchObject({
          result: { isError: false, structuredContent: { htmlRender: { height: PAGE.height } } },
        });
      }
      expect((await rows()).map((row) => [row["title"], row["account_id"]])).toEqual([
        [PAGE.title, "alice"],
        ["Again", "alice"],
      ]);
    });
  });

  it("places a page on the turn of the agent process the bridge names, and on the session's agent when it names none of the session's", async () => {
    const superseded = "0b6a1f52-8c1e-4d0a-9f3b-1c2d3e4f5a6b";
    const current = "5d7e9f10-2a3b-4c5d-8e6f-7a8b9c0d1e2f";
    const bens = "9e8d7c6b-5a49-4382-a716-05f4e3d2c1b0";
    const ITEM = Schema.Array(
      Schema.Struct({
        session_id: Schema.String,
        turn_id: Schema.String,
        process_id: Schema.String,
        title: Schema.String,
      }),
    );
    await withChannel(async ({ address, tokens, helper, sql }) => {
      await sql(`
        INSERT INTO session_processes
          (id, session_id, sealant_workspace_id, kind, harness, status, exited_at, created_at)
        VALUES
          ('${superseded}', '${ALICE_SESSION}', 'ws-mcp', 'agent-protocol', 'claude', 'exited',
           now(), now() - interval '1 hour'),
          ('${current}', '${ALICE_SESSION}', 'ws-mcp', 'agent-protocol', 'claude', 'running',
           NULL, now()),
          ('${bens}', '${BEN_SESSION}', 'ws-mcp-ben', 'agent-protocol', 'claude', 'running',
           NULL, now())`);
      await sql(`
        INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status)
        VALUES
          ('turn-superseded', '${ALICE_SESSION}', '${superseded}', 1, 'before', 'completed'),
          ('turn-current', '${ALICE_SESSION}', '${current}', 2, 'after', 'running'),
          ('turn-ben', '${BEN_SESSION}', '${bens}', 1, 'ben', 'running')`);
      const renderAs = async (title: string, env: Record<string, string>) => {
        const harness = startMendMcp(helper, {
          MEND_SESSION_ENDPOINT: `http://${address}`,
          MEND_SESSION_ID: ALICE_SESSION,
          MEND_SESSION_TOKEN: tokens.alice,
          ...env,
        });
        harness.send(
          rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "claude-code", version: "2" },
          }),
        );
        harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        harness.send(rpc("tools/call", { name: "html_render", arguments: { ...PAGE, title } }));
        const run = await harness.end();
        expect(run.stdout.at(-1)).toMatchObject({ result: { isError: false } });
      };
      try {
        await renderAs("From the superseded process", { MEND_AGENT_PROCESS_ID: superseded });
        await renderAs("From an unnamed process", {});
        await renderAs("Naming Ben's process", { MEND_AGENT_PROCESS_ID: bens });
        await renderAs("Naming no process's id", { MEND_AGENT_PROCESS_ID: "turn-current" });
        const items = Schema.decodeUnknownSync(ITEM)(
          await sql(`
            SELECT session_id, turn_id, process_id, title FROM agent_items
            WHERE kind = 'page' ORDER BY session_id, seq`),
        );
        expect(items).toEqual([
          {
            session_id: ALICE_SESSION,
            turn_id: "turn-superseded",
            process_id: superseded,
            title: "From the superseded process",
          },
          {
            session_id: ALICE_SESSION,
            turn_id: "turn-current",
            process_id: current,
            title: "From an unnamed process",
          },
          {
            session_id: ALICE_SESSION,
            turn_id: "turn-current",
            process_id: current,
            title: "Naming Ben's process",
          },
          {
            session_id: ALICE_SESSION,
            turn_id: "turn-current",
            process_id: current,
            title: "Naming no process's id",
          },
        ]);
      } finally {
        await sql(`DELETE FROM agent_items WHERE kind = 'page'`);
        await sql(
          `DELETE FROM session_processes WHERE id IN ('${superseded}', '${current}', '${bens}')`,
        );
      }
    });
  });

  it("answers 503 while Mend cannot say who calls, and the staged helper asks again", async () => {
    let outages = 2;
    await withChannel(
      async ({ address, tokens, helper, rows }) => {
        const harness = startMendMcp(helper, {
          MEND_SESSION_ENDPOINT: `http://${address}`,
          MEND_SESSION_ID: ALICE_SESSION,
          MEND_SESSION_TOKEN: tokens.alice,
        });
        harness.send(
          rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "claude-code", version: "2" },
          }),
        );
        harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        harness.send(rpc("tools/call", { name: "html_render", arguments: PAGE }));
        const run = await harness.end();
        expect(outages).toBe(0);
        expect(run.stdout).toEqual([
          expect.objectContaining({
            result: expect.objectContaining({ serverInfo: expect.anything() }),
          }),
          expect.objectContaining({ result: expect.objectContaining({ isError: false }) }),
        ]);
        expect(await rows()).toHaveLength(1);
      },
      {
        aliceApi: (base) => ({
          ...base,
          mcpCaller: (named) =>
            Effect.suspend(() =>
              outages > 0
                ? Effect.fail(
                    new McpCallerUnavailableError({
                      message: `the store did not answer ${outages--}`,
                    }),
                  )
                : base.mcpCaller(named),
            ),
        }),
      },
    );
  });

  it("ends every MCP session of a session when its launch ends, and no other session's", async () => {
    await withChannel(async ({ address, tokens, relaunchAlice }) => {
      const first = await connect(address, tokens.alice);
      const second = await connect(address, tokens.alice);
      const ben = await connect(address, tokens.ben);
      await relaunchAlice();
      for (const ended of [first, second]) {
        expect((await ended.call("tools/list", {})).status).toBe(404);
      }
      expect((await ben.call("tools/list", {})).status).toBe(200);
      expect((await (await connect(address, tokens.alice)).call("tools/list", {})).status).toBe(
        200,
      );
    });
  });

  it("ends an MCP session left idle past the bound, and keeps one in use", async () => {
    await withChannel(
      async ({ address, tokens }) => {
        const idle = await connect(address, tokens.alice);
        const busy = await connect(address, tokens.alice);
        for (let tick = 0; tick < 12; tick++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect((await busy.call("tools/list", {})).status).toBe(200);
        }
        expect((await idle.call("tools/list", {})).status).toBe(404);
      },
      { idle: "400 millis" },
    );
  });

  it("reads a page-sized body for a tool call only", async () => {
    await withChannel(async ({ address, tokens }) => {
      const padded = "x".repeat(MAX_BODY_BYTES);
      const opening = await post(
        address,
        tokens.alice,
        rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: padded, version: "0" },
        }),
      );
      expect(opening.status).toBe(413);
      const client = await connect(address, tokens.alice);
      expect((await client.call("tools/list", { padded })).status).toBe(413);
    });
  });

  it("refuses a request with no token, and a one-off write's token", async () => {
    await withChannel(async ({ address }) => {
      const anonymous = await fetch(`http://${address}${MEND_MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(rpc("tools/list", {})),
      });
      expect(anonymous.status).toBe(401);
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const network = yield* SessionChannelNetworkHost;
          const sockets = yield* SessionSocketHost;
          const tokens = yield* SessionChannelTokensRepo;
          const alice = sessionApi(ALICE_SESSION, yield* SessionProcessesRepo);
          yield* sockets.start(ALICE_SESSION, {
            ...alice,
            channelFor: () => Effect.succeed({ ok: true, api: alice } as const),
          });
          const write = yield* tokens.issueWrite("launch-alice", "alice");
          const answer = yield* Effect.promise(() =>
            post(network.address ?? "", write, rpc("tools/list", {}), {
              "x-mend-session-id": ALICE_SESSION,
            }),
          );
          expect(answer.status).toBe(403);
        }).pipe(Effect.provide(channelLayer())),
      ),
    );
  });
  it("publishes one page item through the channel, also after completion, and a retry adds none", async () => {
    await withChannel(async ({ address, tokens, sql }) => {
      await sql(
        "INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, harness, status) VALUES ('page-protocol', 's-mcp-alice', 'ws-page', 'agent-protocol', 'claude', 'running')",
      );
      await sql(
        "INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status) VALUES ('page-turn', 's-mcp-alice', 'page-protocol', 0, 'chart', 'running')",
      );
      try {
        const client = await connect(address, tokens.alice);
        const first = resultOf(await client.render(PAGE, "protocol-publish"));
        await sql("UPDATE agent_turns SET status = 'completed' WHERE id = 'page-turn'");
        const late = resultOf(await client.render(PAGE, "protocol-late"));
        expect(resultOf(await client.render(PAGE, "protocol-publish"))).toEqual(first);
        const items = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              kind: Schema.String,
              turn_id: Schema.String,
              provider_item_id: Schema.String,
              seq: Schema.Number,
              data: Schema.Unknown,
            }),
          ),
        )(
          await sql(
            "SELECT kind, turn_id, provider_item_id, seq, data FROM agent_items WHERE session_id = 's-mcp-alice' ORDER BY seq",
          ),
        );
        expect(
          items.map((item) => [item.kind, item.turn_id, item.provider_item_id, item.seq]),
        ).toEqual([
          ["page", "page-turn", `mend-page:${first.structuredContent?.htmlRender.attachmentId}`, 1],
          ["page", "page-turn", `mend-page:${late.structuredContent?.htmlRender.attachmentId}`, 2],
        ]);
        expect(JSON.stringify(items)).not.toContain(PAGE.html);
      } finally {
        await sql("DELETE FROM session_processes WHERE id = 'page-protocol'");
      }
    });
  });
});
