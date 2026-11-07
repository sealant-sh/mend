import { AgentItemId, SessionId } from "@mend/domain";
import {
  McpAppError,
  McpAppRef,
  McpAppResourceResult,
  McpAppSnapshot,
  McpAppToolInfo,
  McpAppToolResult,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { SessionNotSteerable } from "./sessions.ts";

const params = { id: SessionId, itemId: AgentItemId };
const name = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)));
const errors = [NotFound, McpAppError, SessionNotSteerable];

/** Snapshot reads inherit session visibility; callbacks and context require steering rights. */
export const mcpAppsGroup = HttpApiGroup.make("mcpApps")
  .add(
    HttpApiEndpoint.get("listForSession", "/sessions/:id/mcp-apps", {
      params: { id: SessionId },
      success: Schema.Array(McpAppRef),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("snapshot", "/sessions/:id/mcp-apps/:itemId", {
      params,
      success: McpAppSnapshot,
      error: [NotFound, McpAppError],
    }),
  )
  .add(
    HttpApiEndpoint.get("toolInfo", "/sessions/:id/mcp-apps/:itemId/tool-info", {
      params,
      query: { name },
      success: McpAppToolInfo,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("callTool", "/sessions/:id/mcp-apps/:itemId/call-tool", {
      params,
      payload: Schema.Struct({ name, arguments: Schema.Record(Schema.String, Schema.Unknown) }),
      success: McpAppToolResult,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("readResource", "/sessions/:id/mcp-apps/:itemId/resource", {
      params,
      query: {
        uri: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
      },
      success: McpAppResourceResult,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.put("updateModelContext", "/sessions/:id/mcp-apps/:itemId/context", {
      params,
      payload: Schema.Struct({
        content: Schema.optional(Schema.Array(Schema.Unknown)),
        structuredContent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
      success: Schema.Void,
      error: errors,
    }),
  )
  .middleware(AuthMiddleware);
