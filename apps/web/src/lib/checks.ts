import type { AgentItemDto } from "@mend/agent-conversation";

/** Commands people run to check a change: tests, typechecks, linters, builds. */
const CHECK_WORDS =
  /(^|[\s/:])(test|tests|vitest|jest|pytest|mocha|typecheck|tsc|lint|oxlint|eslint|biome|build|check|clippy|vet|ruff|mypy)(\s|$|:)/;

/** Names a harness gives its shell tool, which say nothing about the command itself. */
const TOOL_NAMES: ReadonlySet<string> = new Set(["Bash", "Shell", "Command"]);

/**
 * One check as the record shows it: the command, how it ended, and when. `unknown` is a command
 * whose outcome the record does not hold (Claude's tool call carries no exit code).
 */
export interface ObservedCheck {
  readonly command: string;
  readonly result: "passed" | "failed" | "running" | "unknown";
  readonly exitCode: number | null;
  readonly at: string;
}

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

/** Codex records `exitCode`; anything else records none. */
const exitCodeOf = (data: unknown): number | null => {
  if (!isRecord(data)) return null;
  const code = data["exitCode"] ?? data["exit_code"];
  return typeof code === "number" ? code : null;
};

const resultOf = (item: AgentItemDto, exitCode: number | null): ObservedCheck["result"] => {
  if (item.status === "in-progress") return "running";
  if (exitCode !== null) return exitCode === 0 ? "passed" : "failed";
  if (item.status === "failed") return "failed";
  return "unknown";
};

/**
 * The checks the agent ran, as its command steps recorded them: the latest run of each command
 * that reads as a test, typecheck, lint or build, newest first. What ran, never a verdict on the
 * change. A run whose exit the record does not hold reads `unknown`, not passed; a check the agent
 * only said it ran is not here.
 */
export const observedChecks = (
  items: ReadonlyArray<AgentItemDto>,
): ReadonlyArray<ObservedCheck> => {
  const latest = new Map<string, ObservedCheck>();
  for (const item of items) {
    if (item.kind !== "command-execution" || item.status === "declined") continue;
    const command = stepCommand(item);
    if (command === null || !CHECK_WORDS.test(command)) continue;
    const exitCode = exitCodeOf(item.data);
    const check: ObservedCheck = {
      command,
      exitCode,
      at: item.updatedAt,
      result: resultOf(item, exitCode),
    };
    const seen = latest.get(command);
    if (seen === undefined || seen.at <= check.at) latest.set(command, check);
  }
  return [...latest.values()].toSorted((a, b) => b.at.localeCompare(a.at));
};
