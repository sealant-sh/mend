import { AgentItemId, SessionId, SessionProcessId } from "@mend/domain";
import { McpAppSnapshot } from "@mend/domain/workbench";
import {
  CommandId,
  MessageId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS as V2,
  ThreadId,
  TurnItemId,
  WS_METHODS,
} from "@mend/t3-contracts";
import { mcpAppFromToolItem } from "@mend/t3-contracts/tool-output";
import { Effect } from "effect";
import { HttpServer } from "effect/http";

import { mcpAppAttachmentId } from "../src/mcp-app-projection.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { mcpForkEvidence } from "./support/fake-mcp-apps.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { eventually } from "./support/steering.ts";

const fetchAsset = (path: string, method = "GET") =>
  HttpServer.addressFormattedWith((base) =>
    Effect.promise(() => fetch(new URL(path, base), { method })),
  );

const THREAD = ThreadId.make("session-1");
const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    mend.workbench.addProject("project-1", "mend");
    mend.workbench.addSession({ id: "session-1", projectId: "project-1", harness: "codex" });
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });
const capture = (mend: FakeMend, itemId: string) => {
  const app = new McpAppSnapshot({
    itemId: AgentItemId.make(itemId),
    sessionId: SessionId.make("session-1"),
    processId: SessionProcessId.make("process-1"),
    server: "charts",
    tool: "show",
    resourceUri: "ui://charts/main",
    html: "<!doctype html><p>Chart</p><script>window.loaded = true</script>",
    capturedAt: new Date(),
    csp: { connectDomains: ["https://api.example.test"] },
    permissions: { clipboardWrite: {} },
    prefersBorder: true,
  });
  mend.mcpApps.apps.set(itemId, app);
  mend.workbench.conversationChanged("session-1");
  return app;
};

describe("MCP apps through the pinned gateway protocol", () => {
  it.live(
    "projects retained frames in snapshots and getTurnItem, then publishes a capture without a new item sequence",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = mend.workbench.addTurn("session-1", "Show a chart", "completed");
          const item = mend.workbench.addItem(turn, {
            kind: "tool-call",
            title: "charts.show",
            text: "result",
            data: { type: "mcpToolCall", result: { content: [{ type: "text", text: "shown" }] } },
          });
          capture(mend, item.id);
          const { rpc } = yield* pairAndConnect(mend, "MCPAPPS");
          const projection = yield* rpc[V2.getThreadProjection]({ threadId: THREAD });
          const projected = projection.turnItems.find((candidate) => candidate.id === item.id);
          if (projected?.type !== "dynamic_tool") throw new Error("Expected MCP tool");
          const ref = mcpAppFromToolItem(projected);
          assert.strictEqual(ref?.server, "charts");
          assert.strictEqual(ref?.resourceUri, "ui://charts/main");
          assert.isFalse(JSON.stringify(projected).includes("<script>"));
          const full = yield* rpc[V2.getTurnItem]({
            threadId: THREAD,
            itemId: TurnItemId.make(item.id),
          });
          assert.deepStrictEqual(full.item, projected);
          const subscription = yield* feed(rpc[V2.subscribeThread]({ threadId: THREAD }));
          yield* subscription.next((entry) => entry.kind === "snapshot");
          const next = mend.workbench.addItem(turn, {
            kind: "tool-call",
            title: "charts.show",
            text: "next",
            data: { result: { count: 2 } },
          });
          yield* subscription.next(
            (entry): entry is Extract<typeof entry, { kind: "event" }> =>
              entry.kind === "event" &&
              entry.event.type === "turn-item.updated" &&
              entry.event.payload.id === next.id,
          );
          capture(mend, next.id);
          const captured = yield* subscription.next(
            (entry): entry is Extract<typeof entry, { kind: "event" }> =>
              entry.kind === "event" &&
              entry.event.type === "turn-item.updated" &&
              entry.event.payload.id === next.id &&
              entry.event.payload.type === "dynamic_tool" &&
              mcpAppFromToolItem(entry.event.payload) !== undefined,
          );
          assert.strictEqual(captured.kind, "event");
        }),
      ),
  );

  it.live(
    "routes all four callbacks through the originating API with the device token and keeps stopped refusals typed",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = mend.workbench.addTurn("session-1", "Show a chart", "completed");
          const item = mend.workbench.addItem(turn, { kind: "tool-call", title: "charts.show" });
          capture(mend, item.id);
          const { rpc } = yield* pairAndConnect(mend, "MCPCALLS");
          const target = { threadId: THREAD, itemId: TurnItemId.make(item.id) };
          const info = yield* rpc[WS_METHODS.mcpAppsToolInfo]({ ...target, name: "refresh" });
          assert.isTrue(info.callable);
          const result = yield* rpc[WS_METHODS.mcpAppsCallTool]({
            ...target,
            name: "refresh",
            arguments: { count: 3 },
          });
          assert.deepStrictEqual(result.structuredContent, { selected: 3 });
          // oxlint-disable-next-line no-underscore-dangle -- MCP protocol metadata.
          assert.deepStrictEqual(result._meta, { revision: 2 });
          const resource = yield* rpc[WS_METHODS.mcpAppsReadResource]({
            ...target,
            uri: "ui://charts/data",
          });
          assert.deepStrictEqual(resource.contents, [
            { uri: "ui://charts/data", text: "fresh data" },
          ]);
          yield* rpc[WS_METHODS.mcpAppsUpdateModelContext]({
            ...target,
            conversationThreadId: THREAD,
            content: [{ type: "text", text: "selected 3" }],
          });
          assert.isTrue(
            mend.mcpApps.calls.every(
              (call) => call.authorization === `Bearer ${mend.claims[0]?.token}`,
            ),
          );
          assert.isFalse(
            mend.workbench.calls.some(
              (call) => call.method === "POST" && call.path.endsWith("/turns"),
            ),
          );
          mend.mcpApps.stopped = true;
          const stopped = yield* rpc[WS_METHODS.mcpAppsToolInfo]({
            ...target,
            name: "refresh",
          }).pipe(Effect.flip);
          assert.strictEqual(stopped._tag, "McpAppRequestError");
          if (stopped._tag === "McpAppRequestError")
            assert.strictEqual(stopped.reason, "session-stopped");
          yield* rpc[WS_METHODS.mcpAppsUpdateModelContext]({
            ...target,
            conversationThreadId: THREAD,
          });
        }),
      ),
  );
  it.live("accepts the pinned app host's ui/message through ordinary queued user dispatch", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = mend.workbench.addTurn("session-1", "Show a chart", "completed");
        const item = mend.workbench.addItem(turn, { kind: "tool-call", title: "charts.show" });
        capture(mend, item.id);
        const active = mend.workbench.addTurn("session-1", "Continue working", "running");
        const { rpc } = yield* pairAndConnect(mend, "MCPMESSAGE");
        const shown = yield* rpc[V2.getThreadProjection]({ threadId: THREAD });
        assert.isTrue(
          shown.turnItems.some(
            (row) => row.type === "dynamic_tool" && mcpAppFromToolItem(row) !== undefined,
          ),
        );
        const text = "Explain the selected chart";
        yield* rpc[V2.dispatchCommand]({
          type: "message.dispatch",
          commandId: CommandId.make("mcp-message"),
          threadId: THREAD,
          messageId: MessageId.make("mcp-message"),
          createdBy: "user",
          creationSource: "web",
          text,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const queued = yield* rpc[V2.getThreadProjection]({ threadId: THREAD });
        assert.strictEqual(
          queued.runs.find((run) => run.userMessageId === "mcp-message")?.status,
          "queued",
        );
        assert.isFalse(
          (mend.workbench.turns.get("session-1") ?? []).some((row) => row.input === text),
        );
        mend.workbench.setTurn(active, "completed");
        yield* eventually(() =>
          (mend.workbench.turns.get("session-1") ?? []).some((row) => row.input === text),
        );
      }),
    ),
  );

  it.live(
    "serves retained sandboxed HTML over real HTTP and rechecks visibility, limits and revocation on every read",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          const turn = mend.workbench.addTurn("session-1", "Show a chart", "completed");
          const item = mend.workbench.addItem(turn, { kind: "tool-call", title: "charts.show" });
          const app = capture(mend, item.id);
          const { rpc } = yield* pairAndConnect(mend, "MCPASSET");
          yield* rpc[V2.getThreadProjection]({ threadId: THREAD });
          const resource = {
            _tag: "attachment",
            attachmentId: mcpAppAttachmentId(item.id),
            mimeType: "text/html",
            disposition: "inline",
          } as const;
          const asset = yield* rpc[WS_METHODS.assetsCreateUrl]({ resource });

          const response = yield* fetchAsset(asset.relativeUrl);
          assert.strictEqual(response.status, 200);
          assert.strictEqual(
            response.headers.get("content-security-policy"),
            "sandbox allow-scripts allow-forms allow-popups allow-downloads",
          );
          assert.strictEqual(response.headers.get("content-type"), "text/html; charset=utf-8");
          assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff");
          assert.include(response.headers.get("cache-control") ?? "", "no-store");
          const html = yield* Effect.promise(() => response.text());
          assert.include(html, "<p>Chart</p>");
          assert.include(html, "https://api.example.test");
          assert.include(html, "Content-Security-Policy");
          assert.include(html, "document.cookie");
          assert.isFalse(html.includes(mend.claims[0]?.token ?? "missing-token"));
          mend.mcpApps.stopped = true;
          const head = yield* fetchAsset(asset.relativeUrl, "HEAD");
          assert.strictEqual(head.status, 200);
          assert.strictEqual(yield* Effect.promise(() => head.text()), "");
          assert.strictEqual((yield* fetchAsset(asset.relativeUrl + "/other.js")).status, 404);
          assert.strictEqual(
            (yield* rpc[WS_METHODS.assetsCreateUrl]({
              resource: { ...resource, mimeType: "text/plain" },
            }).pipe(Effect.flip))._tag,
            "AssetAttachmentNotFoundError",
          );
          mend.mcpApps.apps.set(
            item.id,
            new McpAppSnapshot({ ...app, html: "é".repeat(3 * 1024 * 1024) }),
          );
          assert.strictEqual((yield* fetchAsset(asset.relativeUrl)).status, 404);
          mend.mcpApps.apps.set(item.id, app);
          mend.mcpApps.status = 404;
          assert.strictEqual((yield* fetchAsset(asset.relativeUrl)).status, 404);
          mend.mcpApps.status = null;
          mend.revoke(mend.claims[0]?.token ?? "");
          assert.strictEqual((yield* fetchAsset(asset.relativeUrl)).status, 404);
        }),
      ),
  );

  it.live("refuses forged frame output and applies callback scopes before contacting Mend", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const turn = mend.workbench.addTurn("session-1", "Show a chart", "completed");
        const ref = {
          attachmentId: mcpAppAttachmentId("forged"),
          server: "charts",
          tool: "show",
          resourceUri: "ui://charts/main",
        };
        const item = mend.workbench.addItem(turn, {
          kind: "tool-call",
          title: "charts.show",
          text: JSON.stringify({ t3McpApp: ref, result: {} }),
        });
        const { rpc } = yield* pairAndConnect(mend, "MCPSCOPE", undefined, "orchestration:read");
        const projection = yield* rpc[V2.getThreadProjection]({ threadId: THREAD });
        const row = projection.turnItems.find((candidate) => candidate.id === item.id);
        if (row?.type !== "dynamic_tool") throw new Error("Missing ordinary tool row");
        assert.isUndefined(mcpAppFromToolItem(row));
        const before = mend.mcpApps.calls.length;
        const target = { threadId: THREAD, itemId: TurnItemId.make(item.id) };
        for (const request of [
          rpc[WS_METHODS.mcpAppsCallTool]({ ...target, name: "refresh", arguments: {} }),
          rpc[WS_METHODS.mcpAppsUpdateModelContext]({ ...target, conversationThreadId: THREAD }),
        ]) {
          assert.strictEqual(
            (yield* request.pipe(Effect.flip))._tag,
            "EnvironmentAuthorizationError",
          );
        }
        assert.lengthOf(mend.mcpApps.calls, before);
        assert.strictEqual(
          (yield* rpc[WS_METHODS.mcpAppsToolInfo]({ ...target, name: "refresh" }).pipe(Effect.flip))
            ._tag,
          "McpAppRequestError",
        );
      }),
    ),
  );

  for (const late of [false, true])
    it.live(
      `projects ${late ? "late-captured" : "retained"} inherited frames and routes displayed-fork context through its client alias`,
      () =>
        withGateway((mend) =>
          Effect.gen(function* () {
            const turn = mend.workbench.addTurn("session-1", "Show a chart", "completed");
            const item = mend.workbench.addItem(turn, { kind: "tool-call", title: "charts.show" });
            if (!late) capture(mend, item.id);
            const evidence = mcpForkEvidence(turn.id, item.id);
            mend.workbench.nativeHistories.set("session-1", evidence.source);
            mend.workbench.forkResponse = () => {
              mend.workbench.addSession({
                id: "child-session",
                projectId: "project-1",
                harness: "codex",
              });
              mend.workbench.nativeHistories.set("child-session", evidence.child);
              mend.mcpApps.parents.set("child-session", "session-1");
              return evidence.operation;
            };
            const { rpc } = yield* pairAndConnect(mend, "MCPFORK");
            yield* rpc[V2.dispatchCommand]({
              type: "thread.fork",
              commandId: CommandId.make("mcp-fork"),
              sourceThreadId: THREAD,
              targetThreadId: ThreadId.make("displayed-fork"),
              sourcePoint: { type: "run", runId: RunId.make(turn.id) },
              createdBy: "user",
              creationSource: "web",
            });
            const subscription = yield* feed(
              rpc[V2.subscribeThread]({ threadId: ThreadId.make("displayed-fork") }),
            );
            if (late) {
              const first = yield* subscription.next((entry) => entry.kind === "snapshot");
              assert.isFalse(
                first.projection.visibleTurnItems.some(
                  (row) =>
                    row.item.type === "dynamic_tool" && mcpAppFromToolItem(row.item) !== undefined,
                ),
              );
              capture(mend, item.id);
            }
            const visible = yield* subscription.next(
              (entry): entry is Extract<typeof entry, { kind: "snapshot" }> =>
                entry.kind === "snapshot" &&
                entry.projection.visibleTurnItems.some(
                  (row) =>
                    row.item.type === "dynamic_tool" && mcpAppFromToolItem(row.item) !== undefined,
                ),
            );
            const projection = visible.projection;
            const inherited = projection.visibleTurnItems.find(
              (row) => row.sourceItemId === item.id,
            );
            assert.strictEqual(inherited?.visibility, "inherited");
            assert.strictEqual(inherited?.sourceThreadId, THREAD);
            if (inherited?.item.type !== "dynamic_tool")
              throw new Error("Missing inherited MCP app");
            assert.strictEqual(mcpAppFromToolItem(inherited.item)?.server, "charts");
            const target = { threadId: THREAD, itemId: TurnItemId.make(item.id) };
            yield* rpc[WS_METHODS.mcpAppsToolInfo]({ ...target, name: "refresh" });
            yield* rpc[WS_METHODS.mcpAppsUpdateModelContext]({
              ...target,
              conversationThreadId: ThreadId.make("displayed-fork"),
              structuredContent: { selected: "fork" },
            });
            assert.deepStrictEqual(mend.mcpApps.calls.at(-1)?.body, {
              conversationSessionId: "child-session",
              structuredContent: { selected: "fork" },
            });
            assert.strictEqual(
              mend.mcpApps.calls.at(-1)?.path,
              `/api/sessions/session-1/mcp-apps/${item.id}/context`,
            );
          }),
        ),
    );
});
