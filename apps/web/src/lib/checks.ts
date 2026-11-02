import type { AgentItemDto } from "@mend/agent-conversation";

/** Commands people run to check a change: tests, typechecks, linters, builds. */
const CHECK_WORDS =
  /(^|[\s/:])(test|tests|vitest|jest|pytest|mocha|typecheck|tsc|lint|oxlint|eslint|biome|build|check|clippy|vet|ruff|mypy)(\s|$|:)/;

/** One check as the record shows it: the command, how it ended, and when. */
export interface ObservedCheck {
  readonly command: string;
  readonly result: "passed" | "failed" | "running";
  readonly exitCode: number | null;
  readonly at: string;
}

const exitCodeOf = (data: unknown): number | null => {
  if (typeof data !== "object" || data === null || !("exitCode" in data)) return null;
  return typeof data.exitCode === "number" ? data.exitCode : null;
};

/**
 * The checks the agent ran, as its command steps recorded them: the latest run of each command
 * that reads as a test, typecheck, lint or build, newest first. What ran, never a verdict on the
 * change; a check the agent only said it ran is not here.
 */
export const observedChecks = (
  items: ReadonlyArray<AgentItemDto>,
): ReadonlyArray<ObservedCheck> => {
  const latest = new Map<string, ObservedCheck>();
  for (const item of items) {
    if (item.kind !== "command-execution" || item.title === null) continue;
    const command = item.title.trim();
    if (!CHECK_WORDS.test(command)) continue;
    const exitCode = exitCodeOf(item.data);
    const check: ObservedCheck = {
      command,
      exitCode,
      at: item.updatedAt,
      result:
        item.status === "in-progress"
          ? "running"
          : item.status === "failed" || (exitCode !== null && exitCode !== 0)
            ? "failed"
            : "passed",
    };
    const seen = latest.get(command);
    if (seen === undefined || seen.at <= check.at) latest.set(command, check);
  }
  return [...latest.values()].toSorted((a, b) => b.at.localeCompare(a.at));
};
