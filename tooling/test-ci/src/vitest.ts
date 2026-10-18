import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

interface RuntimeCase {
  readonly id: string;
  readonly fullName: string;
  readonly options: {
    readonly mode: string;
    readonly timeout?: number | undefined;
    readonly repeats?: number | undefined;
  };
  result(): { readonly state: string };
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

interface RuntimeConsoleLog {
  readonly content: string;
  readonly taskId?: string | undefined;
  readonly origin?: string | undefined;
}

export interface VitestCiPlugin {
  readonly name: string;
  configureVitest(context: { readonly vitest: RuntimeContext }): void;
}

/** File execution is checked after completion; individual test deadlines are never changed. */
export interface VitestCiGuardOptions {
  readonly packageName: string;
  /** Fixtures may reduce this; ordinary package configurations use the 60-second default. */
  readonly fileBudgetMs?: number;
  /**
   * Gates timing evidence and the file budget; defaults to the repository's CI truthiness rule.
   * Clock warnings fail every run, local ones included.
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

class TimingReporter {
  private context: RuntimeContext | undefined;
  private runId = randomUUID();
  private readonly collectedFiles = new Set<string>();
  private readonly collectedTests = new Set<string>();
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
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
    this.context?.logger.error(`CI_TIMING ${json}`);
  }

  onTestModuleEnd(module: RuntimeModule): void {
    const file =
      this.context === undefined
        ? module.moduleId
        : relative(this.context.config.root, module.moduleId).replaceAll("\\", "/");
    for (const test of module.children.allTests()) {
      const diagnostic = test.diagnostic();
      const timeout = timeoutEvidence(test.options.timeout);
      const repeated =
        (diagnostic?.retryCount ?? 0) > 0 ||
        (diagnostic?.repeatCount ?? 0) > 0 ||
        (test.options.repeats ?? 0) > 0;
      const duration = diagnostic?.duration;
      const state = test.result().state;
      const executed = state === "passed" || state === "failed";
      const comparable =
        executed &&
        duration !== undefined &&
        Number.isFinite(duration) &&
        timeout.timeoutReason === null &&
        timeout.timeoutMs !== null &&
        !repeated;
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
    this.emit({
      kind: "file",
      file,
      durationMs,
      budgetMs: this.fileBudgetMs,
      state: module.state(),
    });
    this.files += 1;
    if (durationMs > this.fileBudgetMs) {
      const error = new Error(
        `CI file execution budget exceeded: ${this.packageName} ${file} took ${durationMs.toFixed(1)} ms > ${this.fileBudgetMs} ms`,
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
      unhandledErrors: errors.length,
    });
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

/**
 * CI traces read one Jest-compatible JSON report per package run from CI_TEST_REPORT_DIR, named
 * after the package directory. Runs outside a pnpm workspace, such as the temporary fixture
 * projects some tests start, write nothing even though they inherit the variable.
 */
const testReportFile = (root: string): string | undefined => {
  const directory = process.env["CI_TEST_REPORT_DIR"];
  if (!directory) return undefined;
  let workspace = root;
  while (!existsSync(join(workspace, "pnpm-workspace.yaml"))) {
    if (dirname(workspace) === workspace) return undefined;
    workspace = dirname(workspace);
  }
  const name = relative(workspace, root).replaceAll("\\", "/").replaceAll("/", "-");
  return resolve(directory, `vitest-${name}.json`);
};

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
    configureVitest({ vitest }) {
      if (registered.has(vitest)) return;
      registered.add(vitest);
      vitest.config.reporters.push(new ClockWarningReporter(options.packageName));
      if (enabled) vitest.config.reporters.push(new TimingReporter(options.packageName, budget));
      const outputFile = testReportFile(vitest.config.root);
      if (outputFile !== undefined) vitest.config.reporters.push(["json", { outputFile }]);
    },
  };
};
