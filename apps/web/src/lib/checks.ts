import type { AgentItemDto } from "@mend/agent-conversation";

/**
 * A pattern for any of `names` as a word of a command. Quotes, `;`, `&`, `|` and brackets end a
 * word too, since a harness may record the shell around the command: `bash -lc 'pnpm test'`.
 */
const words = (names: string): RegExp =>
  new RegExp(`(^|[\\s/:'"(;&|])(${names})(?=[\\s:'");&|]|$)`);

/** Commands people run to check a change: tests, typechecks, linters, builds. */
const CHECK_WORDS = words(
  "test|tests|vitest|jest|pytest|mocha|typecheck|tsc|lint|oxlint|eslint|biome|build|check|clippy|vet|ruff|mypy",
);

/** What sort of check a command is, by the first word that says so. */
export type CheckKind = "tests" | "typecheck" | "lint" | "build" | "check";

const KIND_WORDS: ReadonlyArray<readonly [CheckKind, RegExp]> = [
  ["tests", words("test|tests|vitest|jest|pytest|mocha")],
  ["typecheck", words("typecheck|tsc|mypy")],
  ["lint", words("lint|oxlint|eslint|biome|clippy|vet|ruff")],
  ["build", words("build")],
];

const kindOf = (command: string): CheckKind =>
  KIND_WORDS.find(([, pattern]) => pattern.test(command))?.[0] ?? "check";

/**
 * One check as the record shows it: the command, what sort of check it is, how it ended, how long
 * it took, and when. `unknown` is a command whose outcome the record does not hold (Claude's tool
 * call carries no exit code).
 */
export interface ObservedCheck {
  readonly command: string;
  readonly kind: CheckKind;
  readonly result: "passed" | "failed" | "running" | "unknown";
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly at: string;
}

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

/** The first of `names` the item's record holds as a number: Codex's `exitCode`, `durationMs`. */
const numberField = (data: unknown, names: ReadonlyArray<string>): number | null => {
  if (!isRecord(data)) return null;
  for (const name of names) {
    const value = data[name];
    if (typeof value === "number") return value;
  }
  return null;
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
    const exitCode = numberField(item.data, ["exitCode", "exit_code"]);
    const check: ObservedCheck = {
      command,
      kind: kindOf(command),
      exitCode,
      durationMs: numberField(item.data, ["durationMs", "duration_ms"]),
      at: item.updatedAt,
      result: resultOf(item, exitCode),
    };
    const seen = latest.get(command);
    if (seen === undefined || seen.at <= check.at) latest.set(command, check);
  }
  return [...latest.values()].toSorted((a, b) => b.at.localeCompare(a.at));
};

const KIND_NAMES: Readonly<Record<CheckKind, string>> = {
  tests: "Tests",
  typecheck: "Type check",
  lint: "Lint",
  build: "Build",
  check: "Check",
};

const RESULT_WORDS: Readonly<Record<ObservedCheck["result"], string>> = {
  passed: "passed",
  failed: "failed",
  running: "running",
  unknown: "ran",
};

/**
 * A check's line as the Checks view says it: "Tests passed after checkpoint 5". The checkpoint is
 * the newest one taken before the check finished, so the check ran on that state or a later one.
 */
export const checkTitle = (check: ObservedCheck, checkpoint: number | null): string =>
  `${KIND_NAMES[check.kind]} ${RESULT_WORDS[check.result]}${
    checkpoint === null || check.result === "running" ? "" : ` after checkpoint ${checkpoint}`
  }`;

/** "Took 41s.", "Took 2m 4s.": how long a check ran, when the record holds it. */
export const tookWords = (durationMs: number): string => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `Took ${seconds}s.`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `Took ${minutes}m.` : `Took ${minutes}m ${rest}s.`;
};

/** The ordinal of the newest checkpoint taken at or before `at`; null before the first. */
export const checkpointBefore = (
  checkpoints: ReadonlyArray<{ readonly ordinal: number; readonly createdAt: Date | string }>,
  at: string,
): number | null => {
  const when = Date.parse(at);
  let newest: number | null = null;
  for (const checkpoint of checkpoints)
    if (
      new Date(checkpoint.createdAt).getTime() <= when &&
      (newest === null || checkpoint.ordinal > newest)
    )
      newest = checkpoint.ordinal;
  return newest;
};

/**
 * How many file edits the record holds after the newest check that finished: edits no check has
 * run on since. Zero when no check finished, since the view then already says so.
 */
export const editsSinceChecks = (
  items: ReadonlyArray<AgentItemDto>,
  checks: ReadonlyArray<ObservedCheck>,
): number => {
  const finished = checks.filter((check) => check.result !== "running");
  if (finished.length === 0) return 0;
  const last = finished.reduce((newest, check) => (check.at > newest ? check.at : newest), "");
  return items.filter(
    (item) => item.kind === "file-change" && item.status !== "declined" && item.createdAt > last,
  ).length;
};

/**
 * The Checks tab's fact: "1 failed" while any latest run failed, else "2 passed", else "running";
 * nothing when no check ran or no outcome is recorded.
 */
export const checksFact = (checks: ReadonlyArray<ObservedCheck>): string | undefined => {
  const count = (result: ObservedCheck["result"]) =>
    checks.filter((check) => check.result === result).length;
  if (count("failed") > 0) return `${count("failed")} failed`;
  if (count("passed") > 0) return `${count("passed")} passed`;
  if (count("running") > 0) return "running";
  return undefined;
};
