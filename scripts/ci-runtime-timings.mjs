// The reporters own these versioned records. Read only their timing metadata, never test output.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalDuration = (value) => value === null || finite(value);

/** Parse a reporter line without confusing an ordinary test log with timing evidence. */
export function parseRuntimeTiming(text) {
  if (!text.startsWith("CI_TIMING ")) return { kind: "absent" };
  let value;
  try {
    value = JSON.parse(text.slice("CI_TIMING ".length));
  } catch {
    return { kind: "invalid", reason: "invalid timing JSON" };
  }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !["vitest", "node"].includes(value.runner) ||
    typeof value.package !== "string" ||
    typeof value.runId !== "string" ||
    !value.runId ||
    !["file-start", "file", "test", "summary"].includes(value.kind)
  )
    return { kind: "invalid", reason: "unsupported or incomplete timing record" };
  if (value.kind === "summary") {
    if (
      typeof value.finished !== "boolean" ||
      !Number.isSafeInteger(value.files) ||
      value.files < 0 ||
      !Number.isSafeInteger(value.tests) ||
      value.tests < 0
    )
      return { kind: "invalid", reason: "invalid timing summary" };
  } else {
    const unknownNodeFile =
      value.runner === "node" &&
      value.kind === "test" &&
      value.file === null &&
      value.reason === "file-not-exposed";
    if (!unknownNodeFile && (typeof value.file !== "string" || !value.file))
      return { kind: "invalid", reason: "timing record has no file identity" };
    if (
      value.kind !== "file-start" &&
      (!optionalDuration(value.durationMs) || typeof value.state !== "string")
    )
      return { kind: "invalid", reason: "invalid timing duration or state" };
    if (value.kind === "file" && !finite(value.budgetMs))
      return { kind: "invalid", reason: "invalid file budget" };
    if (
      value.kind === "test" &&
      (typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        !optionalDuration(value.timeoutMs))
    )
      return { kind: "invalid", reason: "invalid test identity or timeout" };
  }
  return { kind: "record", value };
}

/** Keep runtime evidence separate from incomplete default-reporter and static-source estimates. */
export function summarizeRuntimeTimings(records, invalidRecords) {
  const runs = new Map();
  const tests = [];
  const files = [];
  for (const record of records) {
    const key = JSON.stringify([record.runner, record.package, record.runId]);
    let run = runs.get(key);
    if (!run) {
      run = {
        runner: record.runner,
        package: record.package,
        runId: record.runId,
        cached: false,
        observedFiles: 0,
        observedTests: 0,
        summary: null,
      };
      runs.set(key, run);
    }
    run.cached ||= record.cached;
    if (record.kind === "summary") run.summary = record;
    if (record.kind === "file") {
      files.push(record);
      run.observedFiles++;
    }
    if (record.kind !== "test") continue;
    run.observedTests++;
    // Reporter diagnostics aggregate retries/repeats. Never compare that sum to one attempt's budget.
    const assessed =
      !record.cached &&
      ["passed", "failed"].includes(record.state) &&
      record.durationMs !== null &&
      record.timeoutMs !== null &&
      record.timeoutMs > 0 &&
      record.retryCount === 0 &&
      record.repeatCount === 0;
    const ratio = assessed ? record.durationMs / record.timeoutMs : null;
    tests.push({ ...record, ratio, atLeastHalfTimeout: ratio === null ? null : ratio >= 0.5 });
  }
  return {
    schemaVersion: 1,
    thresholdRatio: 0.5,
    runs: [...runs.values()].map((run) => ({
      ...run,
      complete:
        run.summary?.finished === true &&
        run.summary.files === run.observedFiles &&
        run.summary.tests === run.observedTests &&
        (run.summary.collectedFiles === undefined ||
          run.summary.collectedFiles === run.observedFiles) &&
        (run.summary.collectedTests === undefined ||
          run.summary.collectedTests === run.observedTests),
    })),
    files,
    tests,
    invalidRecords,
    assessedCurrentLeaves: tests.filter((test) => test.ratio !== null).length,
    flaggedCurrentLeaves: tests.filter((test) => test.atLeastHalfTimeout === true).length,
    unknownOrUnassessedLeaves: tests.filter((test) => test.ratio === null).length,
  };
}
