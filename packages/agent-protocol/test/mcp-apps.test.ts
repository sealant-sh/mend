import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue, Schema, Stream } from "effect";

import {
  AgentProtocolError,
  CodexAdapter,
  codexMcpAppTarget,
  makeCodexMcpApps,
  type AgentTransport,
} from "../src/index.ts";

// Ordinary use: each MCP app's buttons and resource reads must use the same
// authenticated app-server process, without spending a new agent turn.
const peer = Effect.gen(function* () {
  const output = yield* Queue.unbounded<Uint8Array, AgentProtocolError>();
  const sent: Array<Readonly<Record<string, unknown>>> = [];
  const transport: AgentTransport = {
    send: (bytes) =>
      Effect.sync(() => {
        const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const message = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(raw);
        sent.push(message);
        if (message.id === undefined) return;
        const result =
          message.method === "thread/start"
            ? { thread: { id: "native-thread" } }
            : message.method === "mcpServerStatus/list"
              ? {
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
                }
              : message.method === "mcpServer/resource/read"
                ? {
                    contents: [
                      {
                        uri: "ui://charts/main",
                        mimeType: "text/html;profile=mcp-app",
                        text: "<p>Chart</p>",
                      },
                    ],
                  }
                : message.method === "mcpServer/tool/call"
                  ? {
                      content: [{ type: "text", text: "updated" }],
                      structuredContent: { count: 3 },
                      _meta: { revision: 2 },
                    }
                  : {};
        Queue.offerUnsafe(
          output,
          new TextEncoder().encode(`${JSON.stringify({ id: message.id, result })}\n`),
        );
      }),
    output: Stream.fromQueue(output),
    close: () => Queue.shutdown(output),
  };
  return { transport, sent };
});

describe("Codex MCP apps", () => {
  it("recognizes every app resource URI spelling accepted by T3 v0.1.2", () => {
    for (const app of [
      { mcpAppUi: { resourceUri: "ui://charts/main" } },
      { mcpAppResourceUri: "ui://charts/main" },
      { appContext: { resourceUri: "ui://charts/main" } },
      { mcpAppUi: {}, appContext: { resourceUri: "ui://charts/main" } },
    ]) {
      expect(
        codexMcpAppTarget({ type: "mcpToolCall", server: "charts", tool: "show", ...app }),
      ).toEqual({ server: "charts", tool: "show", resourceUri: "ui://charts/main" });
    }
    expect(
      codexMcpAppTarget({
        type: "mcpToolCall",
        server: "charts",
        tool: "show",
        mcpAppResourceUri: "https://example.com",
      }),
    ).toBeNull();
  });
  it.effect("reports malformed native callback responses as protocol failures", () =>
    Effect.gen(function* () {
      const apps = makeCodexMcpApps(
        () => Effect.succeed({ data: "invalid", contents: null, content: false }),
        () => "native",
      );
      const requests: ReadonlyArray<Effect.Effect<unknown, AgentProtocolError>> = [
        apps.listTools("charts"),
        apps.readResource({ server: "charts", uri: "ui://charts/main" }),
        apps.callTool({ server: "charts", tool: "refresh", arguments: {} }),
      ];
      for (const request of requests) {
        expect(yield* request.pipe(Effect.flip)).toBeInstanceOf(AgentProtocolError);
      }
    }),
  );
  it.effect("advertises app HTML and routes callbacks through the live native thread", () =>
    Effect.gen(function* () {
      const fake = yield* peer;
      const session = yield* CodexAdapter.start(fake.transport, {
        cwd: "/repo",
        permissionMode: "bypass",
      });
      expect(fake.sent[0]?.params).toMatchObject({
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
          },
        },
      });
      const apps = session.mcpApps;
      expect(apps).toBeDefined();
      if (apps === undefined) throw new Error("Codex has no MCP-app callbacks");
      expect(yield* apps.listTools("charts")).toMatchObject([{ name: "refresh" }]);
      expect(yield* apps.readResource({ server: "charts", uri: "ui://charts/main" })).toMatchObject(
        { contents: [{ text: "<p>Chart</p>" }] },
      );
      expect(
        yield* apps.callTool({ server: "charts", tool: "refresh", arguments: { count: 3 } }),
      ).toEqual({
        content: [{ type: "text", text: "updated" }],
        structuredContent: { count: 3 },
        _meta: { revision: 2 },
      });
      expect(fake.sent.slice(3)).toMatchObject([
        {
          method: "mcpServerStatus/list",
          params: { threadId: "native-thread", serverName: "charts", detail: "toolsAndAuthOnly" },
        },
        {
          method: "mcpServer/resource/read",
          params: { threadId: "native-thread", server: "charts", uri: "ui://charts/main" },
        },
        {
          method: "mcpServer/tool/call",
          params: {
            threadId: "native-thread",
            server: "charts",
            tool: "refresh",
            arguments: { count: 3 },
          },
        },
      ]);
      yield* session.close();
      const before = fake.sent.length;
      expect(
        yield* apps
          .callTool({ server: "charts", tool: "refresh", arguments: {} })
          .pipe(Effect.flip),
      ).toBeInstanceOf(AgentProtocolError);
      expect(fake.sent).toHaveLength(before);
    }),
  );
});
