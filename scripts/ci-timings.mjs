import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

// Read a downloaded GitHub job log. Never call GitHub or execute commands from the log.
const input = process.argv.slice(2);
if (input.length !== 1) {
  console.error("Usage: node scripts/ci-timings.mjs <downloaded-job.log>");
  process.exit(1);
}

try {
  const lines = stripVTControlCharacters(readFileSync(input[0], "utf8"))
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  const steps = [];
  const packages = [];
  const files = [];
  const nodeTests = [];
  const nodeRuns = [];
  const warnings = [];
  const groups = [];
  let first = null;
  let last = null;
  let step = null;
  let ungroupedTask = null;
  let untimestampedLines = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const timestamped = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)$/.exec(line);
    if (!timestamped) {
      untimestampedLines++;
      continue;
    }
    const time = Date.parse(timestamped[1]);
    if (!Number.isFinite(time)) throw new Error(`Invalid timestamp on line ${index + 1}`);
    if (last !== null && time < last) {
      throw new Error(`Timestamps go backwards on line ${index + 1}`);
    }
    first ??= time;
    last = time;
    const text = timestamped[2];
    const group = /^##\[group\](.*)$/.exec(text);
    if (group) {
      const task = /^([^\s:]+):test$/.exec(group[1]);
      if (task || group[1].startsWith("Run ")) ungroupedTask = null;
      let report = null;
      if (task) {
        report = { package: task[1], reportedDurationMs: null, cached: false, line: index + 1 };
        packages.push(report);
      }
      groups.push(report);
      if (group[1].startsWith("Run ")) {
        if (step) {
          step.observedUntil = timestamped[1];
          step.intervalMs = time - step.startedMs;
          step.boundary = "next Run group";
        }
        step = {
          command: group[1].slice(4),
          startedAt: timestamped[1],
          startedMs: time,
          observedUntil: null,
          intervalMs: null,
          boundary: null,
          line: index + 1,
        };
        steps.push(step);
      }
      continue;
    }
    if (text === "##[endgroup]") {
      groups.pop();
      continue;
    }
    // Turbo emits a failed task header without a collapsible group.
    const failedTask = /^(@?[^\s:]+):test$/.exec(text);
    if (failedTask) {
      ungroupedTask = {
        package: failedTask[1],
        reportedDurationMs: null,
        cached: false,
        line: index + 1,
      };
      packages.push(ungroupedTask);
      continue;
    }
    const owner = ungroupedTask ?? groups.findLast((entry) => entry !== null);
    if (owner && /cache hit/.test(text)) owner.cached = true;
    const duration = /^\s*Duration\s+(\d+(?:\.\d+)?)(ms|s)\b/.exec(text);
    if (duration && owner) {
      owner.reportedDurationMs = Number(duration[1]) * (duration[2] === "s" ? 1000 : 1);
    }
    const file =
      /^\s*[✓❯×]\s+(.+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\((\d+) tests?([^)]*)\)\s+(\d+(?:\.\d+)?)ms\s*$/.exec(
        text,
      );
    if (file) {
      files.push({
        package: owner?.package ?? null,
        file: file[1],
        tests: Number(file[2]),
        details: file[3].trim(),
        reportedDurationMs: Number(file[4]),
        cached: owner?.cached ?? false,
        line: index + 1,
      });
    }
    const nodeTest = /^\s*([✔✖﹣]) (.+) \((\d+(?:\.\d+)?)ms\)(.*)$/.exec(text);
    if (nodeTest) {
      nodeTests.push({
        name: nodeTest[2],
        status: { "✔": "passed", "✖": "failed", "﹣": "skipped" }[nodeTest[1]],
        reportedDurationMs: Number(nodeTest[3]),
        file: null,
        line: index + 1,
      });
    }
    const nodeDuration = /^ℹ duration_ms (\d+(?:\.\d+)?)$/.exec(text);
    if (nodeDuration) {
      nodeRuns.push({
        command: step?.command ?? null,
        reportedDurationMs: Number(nodeDuration[1]),
      });
    }
    if (/using time, but is not advancing the test clock/i.test(text)) {
      warnings.push({ kind: "unadvanced-test-clock", line: index + 1 });
    }
  }
  if (first === null || last === null || steps.length === 0) {
    throw new Error("No timestamped GitHub Run groups found; supply a complete downloaded job log");
  }
  if (step) {
    step.intervalMs = last - step.startedMs;
    step.observedUntil = new Date(last).toISOString();
    step.boundary = "last log line (completion unknown)";
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        source: input[0],
        observedLogSpanMs: last - first,
        untimestampedLines,
        steps: steps.map(({ startedMs: _, ...entry }) => entry),
        packages: packages.sort(
          (a, b) => (b.reportedDurationMs ?? 0) - (a.reportedDurationMs ?? 0),
        ),
        files: files.sort((a, b) => b.reportedDurationMs - a.reportedDurationMs),
        nodeTests: nodeTests.sort((a, b) => b.reportedDurationMs - a.reportedDurationMs),
        nodeRuns,
        warnings,
        limitations: [
          "Run intervals end at the next Run group, including intervening overhead; the final interval may be truncated. These are not API step durations.",
          "Turbo buffers task output. Package and file durations come from reporter values, never from the timestamps of flushed lines. Cached durations describe the original execution.",
          "Parallel package/file/test durations cannot be added to obtain job wall time. File durations describe reporter test execution, excluding some setup and collection.",
          "Node spec output lacks file identity and may include parent suite timings. Cases remain unattributed; do not sum them into file durations.",
          "Missing summaries remain missing. This timing report neither establishes suite completion nor turns a failed run into a passing run.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
