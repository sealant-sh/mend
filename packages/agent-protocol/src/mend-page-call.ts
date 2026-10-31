import {
  type AgentEventItem,
  HTML_RENDER_TOOL,
  MEND_MCP_SERVER,
  MEND_PAGE_CALL_FIELD,
  MendPageCall,
  type MendPageCallFailure,
} from "@mend/domain/workbench";
import { Schema } from "effect";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: JsonObject, key: string): string | null => {
  const field = value[key];
  return typeof field === "string" ? field : null;
};

// Codex gives an MCP tool's call a namespace of `mcp__<server>__` (or the bare server name when
// it does not prefix MCP tools) beside the bare tool name (codex-rs `codex-mcp/src/tools.rs`).
const MEND_NAMESPACES = new Set([
  MEND_MCP_SERVER,
  `mcp__${MEND_MCP_SERVER}`,
  `mcp__${MEND_MCP_SERVER}__`,
]);

const IMPORTED = /^(?:imported_)+/;

export const TOOL_INPUT_ENVELOPE = "$mend.toolInput";

export interface ToolIdentity {
  readonly name: string | null;
  readonly namespace: string | null;
}

/** Whether a call names Mend's own MCP tool `tool`, in any form a harness writes it. */
export const isMendTool = (tool: string, { name, namespace }: ToolIdentity): boolean => {
  if (name === null) return false;
  const bare = name.replace(IMPORTED, "");
  // Claude names an MCP tool `mcp__<server>__<tool>`, and so does Codex without a namespace.
  return (
    bare === `mcp__${MEND_MCP_SERVER}__${tool}` ||
    (bare === tool && (namespace === null || MEND_NAMESPACES.has(namespace)))
  );
};

export const isMendPageTool = (identity: ToolIdentity): boolean =>
  isMendTool(HTML_RENDER_TOOL, identity);

const identityOf = (data: JsonObject): ToolIdentity | null => {
  switch (text(data, "type")) {
    case "tool_use":
      return { name: text(data, "name"), namespace: null };
    case "mcpToolCall":
      return { name: text(data, "tool"), namespace: text(data, "server") };
    case "function_call":
      return { name: text(data, "name"), namespace: text(data, "namespace") };
    default:
      return null;
  }
};

const parsed = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const referenceOf = (value: unknown): string | null => {
  if (!isObject(value)) return null;
  const render = value["htmlRender"];
  if (!isObject(render)) return null;
  const id = text(render, "attachmentId");
  return id === null || id === "" ? null : id;
};

// Codex puts an MCP tool's wall time before its output (codex-rs core/src/tools/context.rs,
// `McpToolOutput::response_payload`): as text before the result, or as a content item of its own.
const CODEX_TIMING = /^Wall time: [^\n]*\nOutput:\n?/;

export const mendPageReferenceIn = (output: unknown): string | null => {
  if (typeof output === "string")
    return mendPageReferenceIn(parsed(output.replace(CODEX_TIMING, "")));
  if (Array.isArray(output)) {
    for (const part of output) {
      const found = mendPageReferenceIn(part);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isObject(output)) return null;
  return (
    referenceOf(output) ??
    mendPageReferenceIn(output["structuredContent"]) ??
    mendPageReferenceIn(output["content"]) ??
    mendPageReferenceIn(output["text"])
  );
};

const withoutHtml = (args: unknown): unknown => {
  if (typeof args === "string") {
    const value = parsed(args);
    return isObject(value) ? JSON.stringify(withoutHtml(value)) : null;
  }
  if (!isObject(args)) return args;
  const envelope = args[TOOL_INPUT_ENVELOPE];
  if (isObject(envelope) && typeof envelope["value"] === "string") {
    return {
      ...args,
      [TOOL_INPUT_ENVELOPE]: { ...envelope, value: withoutHtml(envelope["value"]) ?? "{}" },
    };
  }
  const { html: _html, ...rest } = args;
  return rest;
};

const FAILURE_MESSAGE_CHARS = 500;

const failureMessage = (message: string): string =>
  message.length > FAILURE_MESSAGE_CHARS ? `${message.slice(0, FAILURE_MESSAGE_CHARS)}…` : message;

const mendFailureIn = (output: unknown): MendPageCallFailure | null => {
  if (typeof output === "string") return mendFailureIn(parsed(output.replace(CODEX_TIMING, "")));
  if (Array.isArray(output)) {
    for (const part of output) {
      const found = mendFailureIn(part);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isObject(output)) return null;
  const message = text(output, "message");
  if (output["_tag"] === "MendMcpFailure" && message !== null) {
    return { code: text(output, "code"), message: failureMessage(message) };
  }
  return (
    mendFailureIn(output["structuredContent"]) ??
    mendFailureIn(output["content"]) ??
    mendFailureIn(output["text"])
  );
};

const firstTextIn = (output: unknown): string | null => {
  if (typeof output === "string") return output.replace(CODEX_TIMING, "").trim() || null;
  if (Array.isArray(output)) {
    for (const part of output) {
      const found = firstTextIn(part);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isObject(output)) return null;
  return firstTextIn(output["text"]) ?? firstTextIn(output["content"]);
};

const failureOf = (output: unknown, error: unknown): MendPageCallFailure =>
  mendFailureIn(output) ?? {
    code: null,
    message: failureMessage(
      (isObject(error) ? text(error, "message") : null) ??
        firstTextIn(output) ??
        "The call failed.",
    ),
  };

const isMarker = Schema.is(MendPageCall);

// Codex reports a tool's failure as the call's `status`: `failed` with an `error` when the call
// never reached the server, or with the result when the server answered with `isError`, which
// the app-server's result does not keep (codex-rs `core/src/mcp_tool_call.rs`).
const callFailed = (data: JsonObject): boolean => {
  const result = data["result"];
  return (
    text(data, "status") === "failed" ||
    isObject(data["error"]) ||
    (isObject(result) && result["isError"] === true)
  );
};

const compacted = (
  item: AgentEventItem,
): { readonly data: JsonObject; readonly marker: MendPageCall } | null => {
  const data = item.data;
  if (item.kind !== "tool-call" || !isObject(data)) return null;
  const identity = identityOf(data);
  if (identity === null || !isMendPageTool(identity)) return null;
  const { result, error, input, arguments: args, [MEND_PAGE_CALL_FIELD]: kept, ...rest } = data;
  const marker: MendPageCall = isMarker(kept)
    ? kept
    : callFailed(data)
      ? { attachmentId: null, failure: failureOf(result, error) }
      : { attachmentId: mendPageReferenceIn(result), failure: null };
  return {
    marker,
    data: {
      ...rest,
      ...(input === undefined ? {} : { input: withoutHtml(input) }),
      ...(args === undefined ? {} : { arguments: withoutHtml(args) }),
      [MEND_PAGE_CALL_FIELD]: marker,
    },
  };
};

const withMarker = (
  item: AgentEventItem,
  data: JsonObject,
  marker: MendPageCall,
): AgentEventItem => ({
  ...item,
  status: marker.failure === null ? item.status : "failed",
  text: null,
  data: { ...data, [MEND_PAGE_CALL_FIELD]: marker },
});

export const compactMendPageCall = (item: AgentEventItem): AgentEventItem => {
  const call = compacted(item);
  return call === null ? item : withMarker(item, call.data, call.marker);
};

export const withMendPageResult = (
  item: AgentEventItem,
  output: unknown,
  failed: boolean,
): AgentEventItem | null => {
  const call = compacted(item);
  if (call === null) return null;
  return withMarker(
    item,
    call.data,
    failed
      ? { attachmentId: null, failure: failureOf(output, null) }
      : { attachmentId: mendPageReferenceIn(output), failure: null },
  );
};

export const requestInputWithoutPageHtml = (toolName: string, input: JsonObject): unknown =>
  isMendPageTool({ name: toolName, namespace: null }) ? withoutHtml(input) : input;
