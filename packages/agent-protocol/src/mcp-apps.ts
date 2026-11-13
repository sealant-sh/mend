import {
  McpAppResourceResult,
  McpAppTarget,
  McpAppTool,
  McpAppToolResult,
  type McpAppTarget as AppTarget,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { AgentProtocolError } from "./types.ts";

/** Operations on the live provider's own MCP connections; none starts an agent turn. */
export interface AgentMcpApps {
  readonly listTools: (
    server: string,
  ) => Effect.Effect<ReadonlyArray<McpAppTool>, AgentProtocolError>;
  readonly callTool: (input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<McpAppToolResult, AgentProtocolError>;
  readonly readResource: (input: {
    readonly server: string;
    readonly uri: string;
  }) => Effect.Effect<McpAppResourceResult, AgentProtocolError>;
}

/** Reads the three app-URI spellings understood by pinned T3 v0.1.2. */
export const codexMcpAppTarget = (data: unknown): AppTarget | null => {
  const parsed = Schema.decodeUnknownOption(
    Schema.Struct({
      type: Schema.Literal("mcpToolCall"),
      server: Schema.String,
      tool: Schema.String,
      mcpAppUi: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ resourceUri: Schema.optional(Schema.NullOr(Schema.String)) }),
        ),
      ),
      mcpAppResourceUri: Schema.optional(Schema.NullOr(Schema.String)),
      appContext: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ resourceUri: Schema.optional(Schema.NullOr(Schema.String)) }),
        ),
      ),
    }),
  )(data);
  if (parsed._tag === "None") return null;
  const item = parsed.value;
  const target = Schema.decodeUnknownOption(McpAppTarget)({
    server: item.server,
    tool: item.tool,
    resourceUri:
      item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri,
  });
  return target._tag === "Some" ? target.value : null;
};

const malformed = (operation: string) => (cause: unknown) =>
  new AgentProtocolError({
    adapter: "codex",
    operation,
    message: "Codex returned an invalid MCP response.",
    cause,
  });

/** Binds callbacks to the native thread whose app-server owns its MCP credentials. */
export const makeCodexMcpApps = (
  request: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, AgentProtocolError>,
  nativeThreadId: () => string | null,
): AgentMcpApps => {
  const call = (method: string, params: Readonly<Record<string, unknown>>) =>
    Effect.suspend(() => {
      const threadId = nativeThreadId();
      return threadId === null
        ? Effect.fail(
            new AgentProtocolError({
              adapter: "codex",
              operation: method,
              message: "The app's Codex session is closed.",
              cause: null,
            }),
          )
        : request(method, { threadId, ...params });
    });
  const toolsResponse = Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        tools: Schema.optional(Schema.Record(Schema.String, McpAppTool)),
      }),
    ),
  });
  return {
    listTools: Effect.fn("CodexMcpApps.listTools")(function* (server) {
      const response = yield* call("mcpServerStatus/list", {
        serverName: server,
        detail: "toolsAndAuthOnly",
      });
      const parsed = yield* Schema.decodeUnknownEffect(toolsResponse)(response).pipe(
        Effect.mapError(malformed("mcpServerStatus/list")),
      );
      return Object.values(parsed.data.find((entry) => entry.name === server)?.tools ?? {});
    }),
    callTool: Effect.fn("CodexMcpApps.callTool")(function* (input) {
      const response = yield* call("mcpServer/tool/call", input);
      return yield* Schema.decodeUnknownEffect(McpAppToolResult)(response).pipe(
        Effect.mapError(malformed("mcpServer/tool/call")),
      );
    }),
    readResource: Effect.fn("CodexMcpApps.readResource")(function* (input) {
      const response = yield* call("mcpServer/resource/read", input);
      return yield* Schema.decodeUnknownEffect(McpAppResourceResult)(response).pipe(
        Effect.mapError(malformed("mcpServer/resource/read")),
      );
    }),
  };
};
