import {
  McpServer,
  McpServerRemoved,
  McpServersView,
  McpServerWrite,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { AuthMiddleware, PersonCredentialOnly } from "./common.ts";

/** The name, transport or secrets failed a rule; the message says which and quotes nothing sent. */
export class McpServerRejected extends Schema.TaggedError<McpServerRejected>()(
  "McpServerRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * The signed-in person's own MCP servers, keyed by name. Only ever the caller's own. Secret values
 * are write-only: no endpoint returns one. Every endpoint refuses an access key
 * (`PersonCredentialOnly`): a key never places a command that runs in its person's sessions.
 */
export const mcpServersGroup = HttpApiGroup.make("mcpServers")
  .add(HttpApiEndpoint.get("list", "/me/mcp-servers", { success: McpServersView }))
  .add(
    HttpApiEndpoint.put("save", "/me/mcp-servers/:name", {
      params: Schema.Struct({ name: Schema.String }),
      payload: McpServerWrite,
      success: McpServer,
      error: McpServerRejected,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/me/mcp-servers/:name", {
      params: Schema.Struct({ name: Schema.String }),
      success: McpServerRemoved,
    }),
  )
  .middleware(PersonCredentialOnly)
  .middleware(AuthMiddleware);
