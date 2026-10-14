import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

const statusOf = (type, data) =>
  data.skip ? "skipped" : data.todo ? "todo" : type === "test:pass" ? "passed" : "failed";

const reportName = (files) => {
  const first = files.toSorted()[0];
  const path = relative(workspaceRoot, first);
  const name = path.startsWith("..") || isAbsolute(path) ? basename(first) : path;
  return `node-${name.replaceAll("\\", "/").replaceAll("/", "-")}.json`;
};

/**
 * Writes the run as Vitest's Jest-compatible JSON report to CI_TEST_REPORT_DIR for CI traces.
 * Output goes to its own file, so this reporter yields nothing to its destination. A file spans
 * from its first event after being queued (queued files have not started) to its own completion.
 * Node reports files in order, holding a finished file's test events until every earlier file
 * finishes, so the last event can arrive long after the file ended. Without process isolation
 * there is no file completion, and the last event closes the span.
 */
export default async function* ciTestReport(source) {
  const directory = process.env.CI_TEST_REPORT_DIR;
  const files = new Map();
  const startTime = Date.now();
  for await (const { type, data } of source) {
    if (!directory || typeof data?.file !== "string" || type === "test:enqueue") continue;
    const now = Date.now();
    let file = files.get(data.file);
    if (file === undefined) {
      file = { startTime: now, lastEvent: now, failed: false, names: [], assertionResults: [] };
      files.set(data.file, file);
    }
    file.lastEvent = now;
    if (type === "test:complete" && data.nesting === 0 && data.name === data.file) {
      file.completedAt = now;
    } else if (type === "test:start") {
      file.names.length = data.nesting;
      file.names.push(data.name);
    } else if (type === "test:summary" && data.success === false) {
      file.failed = true;
    } else if ((type === "test:pass" || type === "test:fail") && data.details?.type !== "suite") {
      const status = statusOf(type, data);
      if (status === "failed") file.failed = true;
      const ancestorTitles = file.names.slice(0, data.nesting);
      file.assertionResults.push({
        ancestorTitles,
        fullName: [...ancestorTitles, data.name].join(" > "),
        status,
        title: data.name,
        duration: data.details?.duration_ms ?? null,
        failureMessages:
          status === "failed" ? [String(data.details?.error?.message ?? "failed")] : [],
      });
    }
  }
  if (!directory || files.size === 0) return;
  const testResults = [...files].map(([name, file]) => ({
    name,
    startTime: file.startTime,
    endTime: file.completedAt ?? file.lastEvent,
    status: file.failed ? "failed" : "passed",
    message: "",
    assertionResults: file.assertionResults,
  }));
  const results = testResults.flatMap((file) => file.assertionResults);
  const count = (status) => results.filter((result) => result.status === status).length;
  const report = {
    numTotalTests: results.length,
    numPassedTests: count("passed"),
    numFailedTests: count("failed"),
    numPendingTests: count("skipped"),
    numTodoTests: count("todo"),
    startTime,
    success: testResults.every((file) => file.status === "passed"),
    testResults,
  };
  await mkdir(resolve(directory), { recursive: true });
  await writeFile(join(resolve(directory), reportName([...files.keys()])), JSON.stringify(report));
}
