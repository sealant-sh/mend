import { randomUUID } from "node:crypto";

const ciEnabled = () => {
  const ci = process.env["CI"];
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
};

// Keep one record per line through pnpm's Unicode-aware log transport.
const timing = (record) =>
  `CI_TIMING ${JSON.stringify(record)
    .replaceAll("\u0085", "\\u0085")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")}\n`;
const failProcess = () => {
  if (process.exitCode === undefined || Number(process.exitCode) === 0) process.exitCode = 1;
};

/**
 * An additional native Node reporter. Keep spec or TAP as a separate reporter so assertion
 * evidence is retained. Only public per-file summaries establish file execution durations:
 * https://nodejs.org/api/test.html#event-testsummary
 */
export const createCiNodeReporter = ({
  fileBudgetMs = 60_000,
  enforceFileBudget = ciEnabled(),
  packageName = "<root>",
} = {}) => {
  if (!Number.isFinite(fileBudgetMs) || fileBudgetMs <= 0) {
    throw new RangeError(
      "Node test file budget must be a positive, finite number of milliseconds.",
    );
  }

  return async function* ciNodeReporter(source) {
    const runId = randomUUID();
    const common = { schemaVersion: 1, runner: "node", package: packageName, runId };
    const startedFiles = new Set();
    const completedFiles = new Set();
    const unmeasuredFiles = new Set();
    let initialFileEnqueues = true;
    let runSummary = null;
    let reportedTests = 0;
    let overBudgetFiles = 0;

    for await (const { type, data } of source) {
      // Node has no dedicated file-start event. This initial enqueue is best-effort progress
      // evidence only. Limit this to the initial root enqueue sequence: child test IDs restart at
      // one, so even an imported leaf at line 1 named its own file cannot open another file.
      // A test name can never establish a measured file duration.
      const fileEnqueue =
        initialFileEnqueues &&
        type === "test:enqueue" &&
        typeof data.file === "string" &&
        data.name === data.file &&
        data.nesting === 0 &&
        data.line === 1 &&
        data.column === 1 &&
        !startedFiles.has(data.file) &&
        data.testId === startedFiles.size + 1;
      if (type === "test:enqueue" && !fileEnqueue) initialFileEnqueues = false;
      if (fileEnqueue) {
        startedFiles.add(data.file);
        yield timing({
          ...common,
          kind: "file-start",
          file: data.file,
          state: "running",
          durationMs: null,
          startReason: "best-effort-file-enqueue",
        });
      }

      if (type === "test:summary") {
        if (typeof data.file !== "string") {
          runSummary = data;
          continue;
        }
        completedFiles.add(data.file);
        const durationMs =
          Number.isFinite(data.duration_ms) && data.duration_ms >= 0 ? data.duration_ms : null;
        if (durationMs === null) unmeasuredFiles.add(data.file);
        const budgetExceeded = durationMs !== null && durationMs > fileBudgetMs;
        if (budgetExceeded) overBudgetFiles++;
        yield timing({
          ...common,
          kind: "file",
          file: data.file,
          state: durationMs === null ? "incomplete" : data.success ? "passed" : "failed",
          durationMs,
          durationKind: "file-execution",
          budgetMs: fileBudgetMs,
          budgetEnforced: enforceFileBudget,
          budgetExceeded,
          counts: data.counts,
          ...(durationMs === null ? { reason: "file-duration-not-exposed" } : {}),
        });
        if (enforceFileBudget && budgetExceeded) {
          failProcess();
          yield `CI_GUARD Node test file exceeded ${fileBudgetMs}ms: ${data.file} (${durationMs.toFixed(3)}ms observed)\n`;
        }
        continue;
      }

      if ((type === "test:pass" || type === "test:fail") && data.details?.type !== "suite") {
        reportedTests++;
        yield timing({
          ...common,
          kind: "test",
          id: JSON.stringify([
            data.file ?? null,
            data.line ?? null,
            data.column ?? null,
            data.name,
            data.testId ?? data.testNumber,
          ]),
          name: data.name,
          file: data.file ?? null,
          ...(typeof data.file !== "string" ? { reason: "file-not-exposed" } : {}),
          line: data.line ?? null,
          column: data.column ?? null,
          nesting: data.nesting,
          state: data.skip
            ? "skipped"
            : data.todo
              ? "todo"
              : type === "test:pass"
                ? "passed"
                : "failed",
          durationMs: Number.isFinite(data.details?.duration_ms) ? data.details.duration_ms : null,
          timeoutMs: null,
          timeoutReason: "not-exposed",
          timeoutOrigin: "unknown",
          retryCount: null,
          repeatCount: null,
          headroomPercent: null,
          headroomReason: "timeout-not-exposed",
        });
      }
    }

    const incompleteFiles = [...startedFiles].filter((file) => !completedFiles.has(file));
    for (const file of incompleteFiles) {
      yield timing({
        ...common,
        kind: "file",
        file,
        state: "incomplete",
        durationMs: null,
        durationKind: "file-execution",
        budgetMs: fileBudgetMs,
        budgetEnforced: enforceFileBudget,
        budgetExceeded: null,
        reason: "file-summary-not-observed",
      });
    }
    const finished =
      runSummary !== null && incompleteFiles.length === 0 && unmeasuredFiles.size === 0;
    const fileDurationsAvailable = completedFiles.size > 0 || runSummary?.counts.tests === 0;
    const guardFailed =
      enforceFileBudget &&
      (overBudgetFiles > 0 || incompleteFiles.length > 0 || !finished || !fileDurationsAvailable);
    if (guardFailed) failProcess();
    yield timing({
      ...common,
      kind: "summary",
      finished,
      state: !finished ? "incomplete" : !runSummary.success || guardFailed ? "failed" : "passed",
      files: completedFiles.size + incompleteFiles.length,
      tests: reportedTests,
      counts: runSummary?.counts ?? null,
      durationMs: runSummary?.duration_ms ?? null,
      nativeSuccess: runSummary?.success ?? null,
      budgetEnforced: enforceFileBudget,
      guardFailed,
      overBudgetFiles,
      incompleteFiles: incompleteFiles.length,
      ...(runSummary === null
        ? { reason: "run-summary-not-observed" }
        : incompleteFiles.length > 0
          ? { reason: "file-summary-not-observed" }
          : unmeasuredFiles.size > 0
            ? { reason: "file-duration-not-exposed" }
            : !fileDurationsAvailable
              ? { reason: "isolated-file-summaries-not-observed" }
              : {}),
    });
  };
};

export default createCiNodeReporter();
