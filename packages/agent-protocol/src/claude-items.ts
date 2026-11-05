import type { AgentEventItem, AgentItemKind } from "@mend/domain/workbench";

/** Claude's synchronous delegation tools, including the older CLI name. */
export const isClaudeSubAgent = (name: string | null): boolean =>
  name === "Agent" || name === "Task";

/** Keep the wire parent beside the original content block for live and replayed items. */
export const claudeBlockData = (
  block: Readonly<Record<string, unknown>>,
  envelope: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const parent = envelope["parent_tool_use_id"];
  return typeof parent === "string" ? { ...block, parentToolUseId: parent } : block;
};

/** Normalize root ExitPlanMode content identically for callbacks, blocks and transcript replay. */
export function claudeProposedPlan(
  providerTurnId: string,
  toolUseId: string,
  input: unknown,
  parent: unknown,
): AgentEventItem | null {
  if (
    typeof parent === "string" ||
    typeof input !== "object" ||
    input === null ||
    !("plan" in input)
  )
    return null;
  const markdown = input.plan;
  if (typeof markdown !== "string" || !markdown.trim()) return null;
  return {
    providerItemId: `proposed-plan:${toolUseId}`,
    providerTurnId,
    kind: "plan",
    status: "completed",
    title: "Proposed plan",
    text: markdown,
    data: { _tag: "ProposedPlan" },
  };
}

/** A sub-agent is finished when its tool result arrives, rather than when its input closes. */
export const withClaudeSubAgentResult = (
  item: AgentEventItem,
  output: unknown,
  failed: boolean,
): AgentEventItem | null => {
  if (!isClaudeSubAgent(item.title)) return null;
  const data = item.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return { ...item, status: failed ? "failed" : "completed", data: { ...data, result: output } };
};

/**
 * The one mapping from Claude content to Mend item kinds, shared by the live
 * stream-json adapter and the native-transcript backfill so a turn replayed
 * from the transcript can never render differently from the turn as it
 * streamed. The native transcript's content blocks are the same shape the
 * live wire carries — this is a vocabulary, not a conversion.
 */
export const toolKind = (name: string): AgentItemKind => {
  if (name === "Bash" || name === "Shell") return "command-execution";
  if (name === "Write" || name === "Edit" || name === "MultiEdit") return "file-change";
  if (name === "WebSearch" || name === "WebFetch") return "web-search";
  if (name === "TodoWrite" || (name.startsWith("Task") && name !== "Task")) return "plan";
  return "tool-call";
};

/** Kind of one content block (`text` · `thinking` · `tool_use`), by its type and tool name. */
export const contentBlockKind = (type: string | null, toolName: string | null): AgentItemKind =>
  type === "text"
    ? "assistant-message"
    : type === "thinking"
      ? "reasoning"
      : type === "tool_use"
        ? toolKind(toolName ?? "tool")
        : "other";
