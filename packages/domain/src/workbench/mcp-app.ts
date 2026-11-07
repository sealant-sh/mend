import { Effect, Schema } from "effect";

import { AgentItemId, SessionId, SessionProcessId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** MCP Apps HTML documents use this MIME type, including its profile. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** Maximum UTF-8 bytes retained for one app document, matching T3 v0.1.2. */
export const MCP_APP_MAX_HTML_BYTES = 5 * 1024 * 1024;
/** Maximum UTF-8 bytes an app may contribute to the next turn. */
export const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 16 * 1024;

const name = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)));
const resourceUri = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ui:\/\//), Schema.isMaxLength(4096)),
);
const domains = Schema.Array(
  Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(256),
      Schema.isPattern(/^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i),
    ),
  ),
).pipe(Schema.check(Schema.isMaxLength(32)));

/** Only declared origins can enter the app document's content security policy. */
export const McpAppCsp = Schema.Struct({
  connectDomains: Schema.optional(domains),
  resourceDomains: Schema.optional(domains),
  frameDomains: Schema.optional(domains),
  baseUriDomains: Schema.optional(domains),
});
/** Browser permissions declared by the app resource. */
export const McpAppPermissions = Schema.Struct({
  camera: Schema.optional(Schema.Struct({})),
  microphone: Schema.optional(Schema.Struct({})),
  geolocation: Schema.optional(Schema.Struct({})),
  clipboardWrite: Schema.optional(Schema.Struct({})),
});
const presentation = {
  csp: Schema.optional(McpAppCsp),
  permissions: Schema.optional(McpAppPermissions),
  prefersBorder: Schema.optional(Schema.Boolean),
};

/** The provider server and tool are recorded, never supplied by an app callback. */
export const McpAppTarget = Schema.Struct({ server: name, tool: name, resourceUri });
export type McpAppTarget = typeof McpAppTarget.Type;

/** An app document captured from its provider's resources/read response. */
export const McpAppDocument = Schema.Struct({ html: Schema.String, ...presentation });
export type McpAppDocument = typeof McpAppDocument.Type;

/** A durable app reference, visible to anyone who can see its session. */
export class McpAppRef extends Schema.Class<McpAppRef>("McpAppRef")({
  itemId: AgentItemId,
  sessionId: SessionId,
  processId: SessionProcessId,
  ...McpAppTarget.fields,
  ...presentation,
  capturedAt: Timestamp,
}) {}

/** HTML is read separately from the small references used in conversation updates. */
export class McpAppSnapshot extends Schema.Class<McpAppSnapshot>("McpAppSnapshot")({
  ...McpAppRef.fields,
  html: Schema.String,
}) {}

/** The tool description returned by the provider's authenticated MCP connection. */
export const McpAppTool = Schema.StructWithRest(
  Schema.Struct({
    name,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    inputSchema: Schema.optional(Schema.Unknown),
    outputSchema: Schema.optional(Schema.Unknown),
    annotations: Schema.optional(Schema.Unknown),
    _meta: Schema.optional(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type McpAppTool = typeof McpAppTool.Type;

/** MCP callback results retain their content and private app metadata. */
export const McpAppToolResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
  _meta: Schema.optional(Schema.Unknown),
});
export type McpAppToolResult = typeof McpAppToolResult.Type;

/** Resource contents are interpreted by the app host or snapshot parser. */
export const McpAppResourceResult = Schema.Struct({ contents: Schema.Array(Schema.Unknown) });
export type McpAppResourceResult = typeof McpAppResourceResult.Type;

/** A recoverable app request refusal; no provider response or credential enters the wire error. */
export class McpAppError extends Schema.TaggedError<McpAppError>()(
  "McpAppError",
  {
    reason: Schema.Literals([
      "not-an-app",
      "provider-unsupported",
      "session-stopped",
      "tool-not-callable",
      "unsupported-content",
      "context-too-large",
      "login-mismatch",
      "request-failed",
    ]),
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-an-app":
        return "This tool call has no MCP app.";
      case "provider-unsupported":
        return "This session's provider cannot run MCP app requests.";
      case "session-stopped":
        return "The app's session is not running. Send a message in the session that created it to use the app again.";
      case "tool-not-callable":
        return "This app cannot call that tool.";
      case "unsupported-content":
        return "Only text and structured content are supported.";
      case "context-too-large":
        return "Model context is too large.";
      case "login-mismatch":
        return "This app runs on another person's login. Send a message in its session to continue on your own login.";
      case "request-failed":
        return "The app's MCP server request failed.";
    }
  }
}

/** The host uses these hints to confirm a tool call before sending it. */
export const McpAppToolInfo = Schema.Struct({
  callable: Schema.Boolean,
  readOnly: Schema.Boolean,
  title: Schema.optional(Schema.String),
  tool: Schema.optional(McpAppTool),
});
export type McpAppToolInfo = typeof McpAppToolInfo.Type;

/** Context replaces the previous update for this app; blank text clears it. */
export const McpAppModelContext = Schema.Struct({
  itemId: AgentItemId,
  server: name,
  tool: name,
  text: Schema.String,
});
export type McpAppModelContext = typeof McpAppModelContext.Type;

/** Validates the host's text-only context promise and applies its UTF-8 limit. */
export const parseMcpAppModelContext = (input: {
  readonly content?: ReadonlyArray<unknown>;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}): Effect.Effect<string, McpAppError> =>
  Effect.gen(function* () {
    const texts: Array<string> = [];
    const parseText = Schema.decodeUnknownOption(
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    );
    for (const block of input.content ?? []) {
      const parsed = parseText(block);
      if (parsed._tag === "None") return yield* new McpAppError({ reason: "unsupported-content" });
      texts.push(parsed.value.text);
    }
    if (input.structuredContent !== undefined) texts.push(JSON.stringify(input.structuredContent));
    const text = texts.join("\n");
    if (new TextEncoder().encode(text).byteLength > MCP_APP_MODEL_CONTEXT_MAX_BYTES)
      return yield* new McpAppError({ reason: "context-too-large" });
    return text;
  });
