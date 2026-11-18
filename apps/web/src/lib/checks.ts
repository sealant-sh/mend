import type { AgentItemDto } from "@mend/agent-conversation";

/** Names a harness gives its shell tool, which say nothing about the command itself. */
const TOOL_NAMES: ReadonlySet<string> = new Set(["Bash", "Shell", "Command"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const commandText = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (Array.isArray(value) && value.every((part) => typeof part === "string"))
    return value.length === 0 ? null : value.join(" ");
  return null;
};

/**
 * The command a command step ran, from each harness's own item: Claude's `tool_use` block keeps it
 * in `input.command`, Codex's `commandExecution` item in `command`. A title that is only the
 * tool's name is not a command.
 */
export const stepCommand = (item: AgentItemDto): string | null => {
  const data = isRecord(item.data) ? item.data : null;
  const input = data !== null && isRecord(data["input"]) ? data["input"] : null;
  const fromData = commandText(input?.["command"]) ?? commandText(data?.["command"]);
  if (fromData !== null) return fromData;
  if (item.title === null || TOOL_NAMES.has(item.title)) return null;
  return commandText(item.title);
};
