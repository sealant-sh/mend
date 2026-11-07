import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
  McpAppsRepo,
  McpAppsRepoLive,
  MendDBLive,
  migrations,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { SessionId, SessionProcessId } from "@mend/domain";
import { Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpAppRequests, McpAppRequestsLive } from "../src/mcp-app-requests.ts";
import { ProtocolHost, ProtocolHostLive } from "../src/protocol-host.ts";
import { makePipe } from "./support/codex-peer.ts";

const postgres = postgresTestConfig();
const database = `mend_mcp_apps_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const repos = Layer.mergeAll(
  McpAppsRepoLive,
  AgentConversationRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
);
const hostLayer = ProtocolHostLive.pipe(Layer.provide(repos));
const layer = Layer.mergeAll(
  repos,
  hostLayer,
  McpAppRequestsLive.pipe(Layer.provide(hostLayer), Layer.provide(repos)),
).pipe(
  Layer.provideMerge(
    MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) }))),
  ),
);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | McpAppsRepo
    | AgentConversationRepo
    | ProtocolHost
    | McpAppRequests
    | SessionProcessesRepo
    | SqlClient.SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));

const requestSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const appPeer = (resource: unknown) => {
  const peer = makePipe(["native-1", "native-2"]);
  const written: Array<typeof requestSchema.Type> = [];
  const pipe = {
    ...peer.pipe,
    send: (bytes: string | Uint8Array) => {
      const raw: unknown = JSON.parse(
        typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes),
      );
      const request = Schema.decodeUnknownSync(requestSchema)(raw);
      written.push(request);
      if (request.method === "mcpServer/resource/read") {
        if (resource !== undefined) peer.push({ id: request.id, result: resource });
        return Promise.resolve();
      }
      if (request.method === "mcpServerStatus/list") {
        peer.push({
          id: request.id,
          result: {
            data: [
              {
                name: "charts",
                tools: {
                  refresh: {
                    name: "refresh",
                    annotations: { readOnlyHint: true },
                    _meta: { ui: { visibility: ["app"] } },
                  },
                },
              },
            ],
          },
        });
        return Promise.resolve();
      }
      if (request.method === "mcpServer/tool/call") {
        peer.push({
          id: request.id,
          result: { content: [{ type: "text", text: "updated" }], _meta: { revision: 2 } },
        });
        return Promise.resolve();
      }
      return peer.pipe.send(bytes);
    },
  };
  return { ...peer, pipe, written };
};

const attached = (name: string, peer: ReturnType<typeof appPeer>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionId = SessionId.make(`session-${name}`);
    const processId = SessionProcessId.make(`process-${name}`);
    yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status) VALUES (${sessionId},'project','worktree','owner','codex','fixture','mend/fixture',${"a".repeat(40)},'running')`;
    yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status,runs_as) VALUES (${processId},${sessionId},'ws','agent-protocol','codex','running','owner')`;
    const host = yield* ProtocolHost;
    const process = yield* (yield* SessionProcessesRepo).byId(processId);
    if (process === null) return yield* Effect.die("missing process");
    yield* host.attach({
      process,
      pipe: peer.pipe,
      cwd: "/repo",
      permissionMode: "bypass",
      launchedWithLoginOf: "owner",
      runsAs: "owner",
      hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
    });
    const turn = yield* host.submitTurn(sessionId, "show a chart", "owner");
    return { host, sessionId, processId, turn };
  });
const completedItem = (id: string) => ({
  method: "item/completed",
  params: {
    threadId: "thread-1",
    turnId: "native-1",
    item: {
      id,
      type: "mcpToolCall",
      server: "charts",
      tool: "show",
      mcpAppUi: { resourceUri: "ui://charts/main" },
      result: { content: [] },
      error: null,
    },
  },
});
const waitFor = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* read;
      if (ready(value)) return value;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die("MCP app observation did not arrive");
  });

describe.skipIf(postgres.skip)("MCP apps through the Codex pipe and PostgreSQL", () => {
  let created = false;
  beforeAll(async () => {
    await withAdmin(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)),
    );
    created = true;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES ('owner','Owner','owner@example.invalid',now())`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id) SELECT 'project','fixture','/store/fixture','main',id,'owner' FROM organizations LIMIT 1`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES ('worktree','project','fixture','fixture','mend/fixture',${"a".repeat(40)})`;
      }),
    );
  }, 120_000);
  afterAll(async () => {
    if (created)
      await withAdmin(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
        ),
      );
  });

  it("captures once, keeps callback ownership, and replays durable untrusted context on the next turn", async () => {
    const peer = appPeer({
      contents: [
        {
          uri: "ui://charts/main",
          mimeType: " Text/HTML ; profile=mcp-app ",
          blob: Buffer.from("<p>Chart</p>").toString("base64"),
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://charts.example", "https://bad.example; script-src *"],
              },
              permissions: { camera: null, microphone: {} },
              prefersBorder: false,
            },
          },
        },
      ],
    });
    const saved = await run(
      Effect.gen(function* () {
        const { host, sessionId, processId } = yield* attached("capture", peer);
        const repo = yield* McpAppsRepo;
        const requests = yield* McpAppRequests;
        peer.push(completedItem("chart"));
        const refs = yield* waitFor(
          repo.listForSession(sessionId),
          (observed) => observed.length === 1,
        );
        const ref = refs[0];
        if (ref === undefined) return yield* Effect.die("missing app reference");
        expect(ref).not.toHaveProperty("html");
        const snapshot = yield* requests.snapshot({ sessionId, itemId: ref.itemId });
        expect(snapshot).toMatchObject({
          html: "<p>Chart</p>",
          csp: { connectDomains: ["https://charts.example"] },
          permissions: { microphone: {} },
          prefersBorder: false,
        });
        expect(snapshot.permissions).not.toHaveProperty("camera");
        peer.push(completedItem("chart"));
        peer.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "native-1", status: "completed" } },
        });
        const conversations = yield* AgentConversationRepo;
        yield* waitFor(
          conversations.byProviderTurnId(sessionId, "native-1"),
          (turn) => turn?.status === "completed",
        );
        expect(peer.written.filter((r) => r.method === "mcpServer/resource/read")).toHaveLength(1);
        const target = { sessionId, itemId: ref.itemId, accountId: "owner", name: "refresh" };
        expect(yield* requests.callTool({ ...target, arguments: { count: 2 } })).toMatchObject({
          _meta: { revision: 2 },
        });
        expect(peer.written.at(-1)?.params).toEqual({
          threadId: "thread-1",
          server: "charts",
          tool: "refresh",
          arguments: { count: 2 },
        });
        expect(
          yield* requests
            .callTool({ ...target, accountId: "someone-else", arguments: {} })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "login-mismatch" });
        yield* requests.updateModelContext({
          ...target,
          content: [{ type: "text", text: "old selection" }],
        });
        yield* requests.updateModelContext({
          ...target,
          content: [{ type: "text", text: "selected: amber" }],
        });
        yield* host.submitTurn(sessionId, "explain this selection", "owner");
        expect(peer.written.filter((r) => r.method === "turn/start").at(-1)?.params).toMatchObject({
          additionalContext: {
            [`mcp_app_${ref.itemId.replace(/[^\w.-]/g, "_")}`]: {
              kind: "untrusted",
              value: "selected: amber",
            },
          },
          collaborationMode: { mode: "default" },
        });
        yield* host.detach(processId);
        expect(
          yield* requests.callTool({ ...target, arguments: {} }).pipe(Effect.flip),
        ).toMatchObject({ reason: "session-stopped" });
        yield* requests.updateModelContext({ ...target, structuredContent: { selected: "blue" } });
        return { sessionId, itemId: ref.itemId };
      }),
    );
    await run(
      Effect.gen(function* () {
        const repo = yield* McpAppsRepo;
        expect(yield* repo.contextForSession(saved.sessionId)).toMatchObject([
          { text: '{"selected":"blue"}' },
        ]);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO session_history_operations (id,organization_id,actor_id,command_id,intent_digest,operation) SELECT 'app-rollback',organization_id,'owner','app-rollback','fixture',jsonb_build_object('id','app-rollback','organizationId',organization_id,'actorId','owner','commandId','app-rollback','intentDigest','fixture') || '{"intent":{"kind":"rollback"},"progress":{"kind":"complete"},"version":0,"generation":0}'::jsonb FROM projects WHERE id='project'`;
        yield* sql`UPDATE agent_turns SET withdrawn_history_revision=1,withdrawn_by_operation_id='app-rollback' WHERE id=(SELECT turn_id FROM agent_items WHERE id=${saved.itemId})`;
        expect(yield* repo.contextForSession(saved.sessionId)).toEqual([]);
        expect(yield* repo.byItem(saved.itemId)).toMatchObject({ html: "<p>Chart</p>" });
        yield* (yield* McpAppRequests).updateModelContext({ ...saved, content: [] });
        expect(yield* repo.contextForSession(saved.sessionId)).toEqual([]);
        yield* sql`DELETE FROM agent_sessions WHERE id=${saved.sessionId}`;
        expect(yield* repo.byItem(saved.itemId)).toBeNull();
      }),
    );
  });

  it("keeps a completed plain tool row when its UI resource cannot be captured", async () => {
    const peer = appPeer({
      contents: [{ uri: "ui://charts/main", mimeType: "text/html", text: "not an MCP app" }],
    });
    await run(
      Effect.gen(function* () {
        const { sessionId, processId, host } = yield* attached("invalid", peer);
        peer.push(completedItem("ordinary"));
        peer.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "native-1", status: "completed" } },
        });
        yield* waitFor(
          (yield* AgentConversationRepo).byProviderTurnId(sessionId, "native-1"),
          (turn) => turn?.status === "completed",
        );
        expect(yield* (yield* McpAppsRepo).listForSession(sessionId)).toEqual([]);
        yield* host.detach(processId);
      }),
    );
  });

  it("can finish and send another turn while the app resource server is unresponsive", async () => {
    const peer = appPeer(undefined);
    await run(
      Effect.gen(function* () {
        const { sessionId, processId, host } = yield* attached("unresponsive", peer);
        peer.push(completedItem("slow-app"));
        yield* waitFor(
          Effect.sync(() => peer.written),
          (requests) => requests.some((request) => request.method === "mcpServer/resource/read"),
        );
        peer.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "native-1", status: "completed" } },
        });
        yield* waitFor(
          (yield* AgentConversationRepo).byProviderTurnId(sessionId, "native-1"),
          (turn) => turn?.status === "completed",
        );
        yield* host.submitTurn(sessionId, "continue without the chart", "owner");
        expect(
          yield* waitFor(
            (yield* AgentConversationRepo).byProviderTurnId(sessionId, "native-2"),
            (turn) => turn?.status === "running",
          ),
        ).toMatchObject({ status: "running", providerTurnId: "native-2" });
        yield* host.detach(processId);
      }),
    );
  });
});
