import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

interface RuntimeCase {
  readonly id: string;
  readonly fullName: string;
  readonly options: {
    readonly mode: string;
    readonly timeout?: number | undefined;
    readonly repeats?: number | undefined;
  };
  result(): {
    readonly state: string;
    readonly errors?: ReadonlyArray<{ readonly message?: string | undefined }> | undefined;
  };
  meta(): Readonly<Record<string, unknown>>;
  diagnostic():
    | {
        readonly duration: number;
        readonly retryCount: number;
        readonly repeatCount: number;
      }
    | undefined;
}

interface RuntimeModule {
  readonly id: string;
  readonly moduleId: string;
  readonly children: {
    allTests(): Iterable<RuntimeCase>;
    allSuites(): Iterable<{ readonly id: string; readonly fullName: string }>;
  };
  state(): string;
  diagnostic(): { readonly duration: number };
}

interface RuntimeContext {
  readonly config: {
    readonly reporters: {
      push(
        reporter: TimingReporter | ClockWarningReporter | ["json", { readonly outputFile: string }],
      ): number;
    };
    readonly root: string;
  };
  readonly logger: { error(message: string): void };
  readonly state: { catchError(error: unknown, type: string): void };
}

interface RuntimeProject {
  readonly config: { retry?: unknown; readonly setupFiles: string[] };
}

interface RuntimeConsoleLog {
  readonly content: string;
  readonly taskId?: string | undefined;
  readonly origin?: string | undefined;
}

export interface VitestCiPlugin {
  readonly name: string;
  configureVitest(context: {
    readonly vitest: RuntimeContext;
    readonly project: RuntimeProject;
  }): void;
}

/** File execution is checked after completion; individual test deadlines are never changed. */
export interface VitestCiGuardOptions {
  readonly packageName: string;
  /** Fixtures may reduce this; ordinary package configurations use the 60-second default. */
  readonly fileBudgetMs?: number;
  /**
   * Gates the retry, retry records, timing evidence and the file budget; defaults to the
   * repository's CI truthiness rule. Clock warnings fail every run, local ones included.
   */
  readonly enabled?: boolean;
}

type TimeoutEvidence = {
  readonly timeoutMs: number | null;
  readonly timeoutReason: "disabled" | "invalid" | "unavailable" | null;
};

const timeoutEvidence = (timeout: number | undefined): TimeoutEvidence => {
  if (timeout === undefined) return { timeoutMs: null, timeoutReason: "unavailable" };
  if (timeout === 0 || timeout === Infinity)
    return { timeoutMs: timeout === 0 ? 0 : null, timeoutReason: "disabled" };
  if (!Number.isFinite(timeout) || timeout < 0)
    return { timeoutMs: null, timeoutReason: "invalid" };
  return { timeoutMs: timeout, timeoutReason: null };
};

type RetryOutcome = "passed-on-retry" | "failed-twice";

/** One test that needed its retry: the evidence `scripts/ci-flakes.mjs` ranks across runs. */
interface RetryRecord {
  readonly package: string;
  readonly file: string;
  readonly name: string;
  readonly outcome: RetryOutcome;
  readonly firstError: string | null;
  /** Each attempt in order; null when the attempt timer saw too few attempts to apportion them. */
  readonly attemptsMs: ReadonlyArray<number> | null;
  readonly durationMs: number | null;
}

const isDurations = (value: unknown): value is ReadonlyArray<number> =>
  Array.isArray(value) &&
  value.every(
    (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
  );

const ERROR_LIMIT = 500;
const trimError = (message: string | undefined): string | null => {
  if (message === undefined) return null;
  const line = stripVTControlCharacters(message).replace(/\s+/g, " ").trim();
  return line.length > ERROR_LIMIT ? `${line.slice(0, ERROR_LIMIT - 1)}…` : line;
};

const optionalEnv = (name: string): string | null => {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** GitHub's run context; a pull request's commit is its head, not the merge commit CI checks out. */
const githubRun = () => {
  let commit = optionalEnv("GITHUB_SHA");
  const eventPath = optionalEnv("GITHUB_EVENT_PATH");
  if (eventPath !== null && existsSync(eventPath)) {
    const event: unknown = JSON.parse(readFileSync(eventPath, "utf8"));
    const head =
      isObject(event) && isObject(event["pull_request"]) && isObject(event["pull_request"]["head"])
        ? event["pull_request"]["head"]["sha"]
        : undefined;
    if (typeof head === "string" && head !== "") commit = head;
  }
  return {
    job: optionalEnv("GITHUB_JOB"),
    runId: optionalEnv("GITHUB_RUN_ID"),
    runAttempt: optionalEnv("GITHUB_RUN_ATTEMPT"),
    commit,
  };
};

const attemptTime = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const cell = (text: string): string => text.replaceAll("|", "\\|").replace(/\s+/g, " ");

const flakySummary = (packageName: string, records: ReadonlyArray<RetryRecord>): string => {
  const rows = records.map((record) => {
    const error = record.firstError ?? "no error message";
    const attempts =
      record.attemptsMs === null ? "not timed" : record.attemptsMs.map(attemptTime).join(", ");
    return `| ${cell(`${record.file} > ${record.name}`)} | ${cell(error.length > 160 ? `${error.slice(0, 159)}…` : error)} | ${attempts} |`;
  });
  return [
    `### Flaky in this run: ${packageName}`,
    "",
    "These tests failed, then passed on their retry, so they did not fail the run. Each is recorded in this job's `test-report` artifact; `node scripts/ci-flakes.mjs` ranks them across runs.",
    "",
    "| Test | First attempt failed with | Attempts |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "",
  ].join("\n");
};

class TimingReporter {
  private context: RuntimeContext | undefined;
  private runId = randomUUID();
  private readonly collectedFiles = new Set<string>();
  private readonly collectedTests = new Set<string>();
  private readonly retried: RetryRecord[] = [];
  private files = 0;
  private tests = 0;

  private readonly packageName: string;
  private readonly fileBudgetMs: number;

  constructor(packageName: string, fileBudgetMs: number) {
    this.packageName = packageName;
    this.fileBudgetMs = fileBudgetMs;
  }

  onInit(context: RuntimeContext): void {
    this.context = context;
  }

  onTestRunStart(): void {
    this.runId = randomUUID();
    this.collectedFiles.clear();
    this.collectedTests.clear();
    this.retried.length = 0;
    this.files = 0;
    this.tests = 0;
  }

  onTestModuleCollected(module: RuntimeModule): void {
    this.collectedFiles.add(module.moduleId);
    for (const test of module.children.allTests()) this.collectedTests.add(test.id);
  }

  private emit(record: Readonly<Record<string, unknown>>): void {
    // pnpm's line transport also splits Unicode next-line and paragraph separators.
    const json = JSON.stringify({
      schemaVersion: 1,
      runner: "vitest",
      package: this.packageName,
      runId: this.runId,
      ...record,
    })
      .replaceAll("\u0085", "\\u0085")
      .replaceAll(" ", "\\u2028")
      .replaceAll(" ", "\\u2029");
    this.context?.logger.error(`CI_TIMING ${json}`);
  }

  onTestModuleEnd(module: RuntimeModule): void {
    const root = this.context?.config.root;
    const file =
      root === undefined ? module.moduleId : relative(root, module.moduleId).replaceAll("\\", "/");
    const workspace = root === undefined ? undefined : workspaceRoot(root);
    const recordedFile =
      workspace === undefined ? file : relative(workspace, module.moduleId).replaceAll("\\", "/");
    // Earlier attempts of retried tests: the time a retry cost, which the budget does not charge.
    let retriedAttemptsMs = 0;
    for (const test of module.children.allTests()) {
      const diagnostic = test.diagnostic();
      const timeout = timeoutEvidence(test.options.timeout);
      const retryCount = diagnostic?.retryCount ?? 0;
      const repeated =
        retryCount > 0 || (diagnostic?.repeatCount ?? 0) > 0 || (test.options.repeats ?? 0) > 0;
      const duration = diagnostic?.duration;
      const result = test.result();
      const state = result.state;
      const executed = state === "passed" || state === "failed";
      const comparable =
        executed &&
        duration !== undefined &&
        Number.isFinite(duration) &&
        timeout.timeoutReason === null &&
        timeout.timeoutMs !== null &&
        !repeated;
      const timed = test.meta()["mendCiAttemptsMs"];
      const attemptsMs = isDurations(timed) && timed.length === retryCount + 1 ? timed : null;
      if (executed && retryCount > 0) {
        retriedAttemptsMs += attemptsMs?.slice(0, -1).reduce((sum, ms) => sum + ms, 0) ?? 0;
        this.retried.push({
          package: this.packageName,
          file: recordedFile,
          name: test.fullName,
          outcome: state === "passed" ? "passed-on-retry" : "failed-twice",
          firstError: trimError(result.errors?.[0]?.message),
          attemptsMs,
          durationMs: duration ?? null,
        });
      }
      this.emit({
        kind: "test",
        id: test.id,
        file,
        name: test.fullName,
        state,
        durationMs: duration ?? null,
        ...timeout,
        timeoutOrigin: timeout.timeoutReason === "unavailable" ? null : "runtime",
        retryCount: diagnostic?.retryCount ?? null,
        repeatCount: diagnostic?.repeatCount ?? null,
        attemptsMs,
        headroomPercent: comparable ? 100 * (1 - duration / timeout.timeoutMs) : null,
        headroomReason: repeated
          ? "retried-or-repeated"
          : !executed || duration === undefined
            ? "not-executed"
            : timeout.timeoutReason,
      });
      this.tests += 1;
    }
    const durationMs = module.diagnostic().duration;
    const budgetedMs = durationMs - retriedAttemptsMs;
    this.emit({
      kind: "file",
      file,
      durationMs,
      retriedAttemptsMs,
      budgetedMs,
      budgetMs: this.fileBudgetMs,
      state: module.state(),
    });
    this.files += 1;
    if (budgetedMs > this.fileBudgetMs) {
      const retryNote =
        retriedAttemptsMs > 0
          ? ` (${budgetedMs.toFixed(1)} ms without ${retriedAttemptsMs.toFixed(1)} ms of retried attempts)`
          : "";
      const error = new Error(
        `CI file execution budget exceeded: ${this.packageName} ${file} took ${durationMs.toFixed(1)} ms${retryNote} > ${this.fileBudgetMs} ms`,
      );
      this.context?.logger.error(error.message);
      throw error;
    }
  }

  onTestRunEnd(
    _modules: ReadonlyArray<RuntimeModule>,
    errors: ReadonlyArray<unknown>,
    reason: string,
  ): void {
    this.emit({
      kind: "summary",
      finished:
        (reason === "passed" || reason === "failed") &&
        this.files === this.collectedFiles.size &&
        this.tests === this.collectedTests.size,
      reason,
      files: this.files,
      tests: this.tests,
      collectedFiles: this.collectedFiles.size,
      collectedTests: this.collectedTests.size,
      retriedTests: this.retried.length,
      unhandledErrors: errors.length,
    });
    this.recordRetries();
  }

  /** Runs outside a pnpm workspace (temporary fixture projects) write nothing, as for reports. */
  private recordRetries(): void {
    const root = this.context?.config.root;
    const name = root === undefined ? undefined : reportName(root);
    if (name === undefined || this.retried.length === 0) return;
    const directory = optionalEnv("CI_TEST_REPORT_DIR");
    if (directory !== null) {
      const run = githubRun();
      const records = this.retried.map((record) => ({
        schemaVersion: 1,
        ...record,
        ...run,
      }));
      mkdirSync(resolve(directory), { recursive: true });
      writeFileSync(
        resolve(directory, `retried-vitest-${name}.json`),
        `${JSON.stringify(records, null, 2)}\n`,
      );
    }
    const summary = optionalEnv("GITHUB_STEP_SUMMARY");
    const flaky = this.retried.filter((record) => record.outcome === "passed-on-retry");
    if (summary !== null && flaky.length > 0) {
      appendFileSync(summary, flakySummary(this.packageName, flaky));
    }
  }
}

const CLOCK_WARNING = /using time, but is not advancing the test clock/i;

/**
 * Effect prints this warning when a test sleeps on a TestClock nobody advances; such a test waits
 * on real time or hangs. `@mend/test-ci/effect-vitest` makes sure the warning reaches the console.
 */
class ClockWarningReporter {
  private context: RuntimeContext | undefined;
  private readonly locations = new Map<string, string>();
  private readonly packageName: string;

  constructor(packageName: string) {
    this.packageName = packageName;
  }

  onInit(context: RuntimeContext): void {
    this.context = context;
  }

  onTestRunStart(): void {
    this.locations.clear();
  }

  onTestModuleCollected(module: RuntimeModule): void {
    this.locations.set(module.id, module.moduleId);
    for (const test of module.children.allTests()) {
      this.locations.set(test.id, `${module.moduleId} > ${test.fullName}`);
    }
    for (const suite of module.children.allSuites()) {
      this.locations.set(suite.id, `${module.moduleId} > ${suite.fullName}`);
    }
  }

  onUserConsoleLog(log: RuntimeConsoleLog): void {
    if (!CLOCK_WARNING.test(log.content)) return;
    const location =
      (log.taskId === undefined ? undefined : this.locations.get(log.taskId)) ??
      log.origin ??
      "unattributed test console";
    const error = new Error(`${this.packageName} Clock warning: ${location}\n${log.content}`);
    if (this.context === undefined) throw error;
    this.context.logger.error(error.message);
    // Console RPCs are separate from task events: register the failure with the runner
    // immediately so even a late log is included in its exit status and JSON report.
    this.context.state.catchError(error, "Clock warning");
  }
}

const workspaceRoot = (root: string): string | undefined => {
  let workspace = root;
  while (!existsSync(join(workspace, "pnpm-workspace.yaml"))) {
    if (dirname(workspace) === workspace) return undefined;
    workspace = dirname(workspace);
  }
  return workspace;
};

/**
 * CI traces read one Jest-compatible JSON report per package run from CI_TEST_REPORT_DIR, named
 * after the package directory. Runs outside a pnpm workspace, such as the temporary fixture
 * projects some tests start, write nothing even though they inherit the variable.
 */
const reportName = (root: string): string | undefined => {
  const workspace = workspaceRoot(root);
  return workspace === undefined
    ? undefined
    : relative(workspace, root).replaceAll("\\", "/").replaceAll("/", "-");
};

const testReportFile = (root: string): string | undefined => {
  const directory = process.env["CI_TEST_REPORT_DIR"];
  const name = reportName(root);
  if (!directory || name === undefined) return undefined;
  return resolve(directory, `vitest-${name}.json`);
};

const attemptTimer = fileURLToPath(new URL("./vitest-attempts.ts", import.meta.url));

/** Append after CLI reporter resolution, retaining default reporters and explicit JSON output. */
export const vitestCiGuard = (options: VitestCiGuardOptions): VitestCiPlugin => {
  const budget = options.fileBudgetMs ?? 60_000;
  if (!Number.isFinite(budget) || budget <= 0)
    throw new RangeError("The CI file execution budget must be a positive finite number.");
  const ci = process.env["CI"];
  const enabled =
    options.enabled ?? (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0");
  const registered = new WeakSet<RuntimeContext>();
  return {
    name: "mend-test-ci-guard",
    configureVitest({ vitest, project }) {
      // CI retries a failed test once, in every project; a second failure fails the run.
      if (enabled) {
        if (project.config.retry === undefined || project.config.retry === 0) {
          project.config.retry = 1;
        }
        if (!project.config.setupFiles.includes(attemptTimer)) {
          project.config.setupFiles.push(attemptTimer);
        }
      }
      if (registered.has(vitest)) return;
      registered.add(vitest);
      vitest.config.reporters.push(new ClockWarningReporter(options.packageName));
      if (enabled) vitest.config.reporters.push(new TimingReporter(options.packageName, budget));
      const outputFile = testReportFile(vitest.config.root);
      if (outputFile !== undefined) vitest.config.reporters.push(["json", { outputFile }]);
    },
  };
};
