import { itemFailed, type AgentItemDto } from "@mend/agent-conversation";

export interface SubAgentView {
  readonly type: string;
  readonly description: string;
  /** `stopped`: its turn ended before the sub-agent answered. */
  readonly status: "running" | "completed" | "failed" | "stopped";
  readonly prompt: string | null;
  readonly result: string | null;
  readonly model: string | null;
  /** Claude's `run_in_background`: the call returns once the agent starts, as a background task. */
  readonly background: boolean;
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly message: string | null;
  }>;
}

const isRow = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const row = (value: unknown): Readonly<Record<string, unknown>> => (isRow(value) ? value : {});
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const resultText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    const block = row(part);
    return block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [];
  });
  return parts.length === 0 ? null : parts.join("\n\n");
};

/** Provider identity is kept inside the original wire block, independently of Mend's item id. */
export const toolUseId = (item: AgentItemDto): string | null => text(row(item.data)["id"]);
export const parentToolUseId = (item: AgentItemDto): string | null =>
  text(row(item.data)["parentToolUseId"]);

/** Read the two harnesses' delegation calls while leaving ordinary tools in the step table. */
export const subAgentOf = (item: AgentItemDto): SubAgentView | null => {
  const data = row(item.data);
  const name = text(data["name"]) ?? item.title;
  if (
    (item.kind === "tool-call" || item.kind === "plan") &&
    (name === "Agent" || name === "Task")
  ) {
    const input = row(data["input"]);
    return {
      type: text(input["subagent_type"]) ?? "Agent",
      description: text(input["description"]) ?? "Sub-agent",
      prompt: text(input["prompt"]),
      model: text(input["model"]),
      background: input["run_in_background"] === true,
      result: resultText(data["result"]) ?? item.text,
      status: itemFailed(item) ? "failed" : item.status === "in-progress" ? "running" : "completed",
      agents: [],
    };
  }
  if (item.kind !== "tool-call" || data["type"] !== "collabAgentToolCall") return null;
  const agents = Object.entries(row(data["agentsStates"])).map(([id, value]) => ({
    id,
    status: text(row(value)["status"]) ?? "unknown",
    message: text(row(value)["message"]),
  }));
  const status = data["status"];
  return {
    type: text(data["tool"]) ?? "Codex",
    description: text(data["prompt"])?.split("\n")[0] || "Sub-agent",
    prompt: text(data["prompt"]),
    result: item.text,
    model: text(data["model"]),
    background: false,
    status:
      itemFailed(item) || status === "failed"
        ? "failed"
        : item.status === "in-progress" || status === "inProgress"
          ? "running"
          : "completed",
    agents,
  };
};
