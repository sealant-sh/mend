import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./ci-timings.mjs", import.meta.url);
const run = (context, lines) => {
  const directory = mkdtempSync(join(tmpdir(), "mend-ci-timings-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "job.log");
  writeFileSync(log, lines.join("\n"));
  return spawnSync(process.execPath, [script.pathname, log], { encoding: "utf8" });
};
const line = (milliseconds, text) => `${new Date(milliseconds).toISOString()} ${text}`;

test("reports buffered task durations independently of flush times, with nested groups and units", (t) => {
  const child = run(t, [
    `\uFEFF${line(0, "##[group]Run pnpm test")}`,
    line(1, "##[endgroup]"),
    line(8000, "##[group]@mend/a:test"),
    line(8001, "##[group]nested diagnostic"),
    line(8002, "##[endgroup]"),
    line(8003, "\x1b[32m ✓ src/a.test.ts (2 tests | 1 skipped) 1250ms\x1b[0m"),
    line(8004, " Duration 2.50s (tests 1.25s)"),
    line(8005, "##[endgroup]"),
    line(8006, "##[group]@mend/b:test"),
    line(8007, "cache hit, replaying logs"),
    line(8008, " ❯ test/b.spec.tsx (1 test | 1 failed) 80ms"),
    line(8009, " Duration 100ms (tests 80ms)"),
    line(8010, "##[endgroup]"),
    line(10000, "##[group]Run node --test test.mjs"),
    line(10001, "##[endgroup]"),
    line(12000, "✔ preserves state (50.125ms)"),
    line(12001, "﹣ optional adapter (0.1ms) # unavailable"),
    line(12002, "✖ rejects late update (20ms)"),
    line(12003, "ℹ duration_ms 1800.5"),
    line(12004, "Post job cleanup."),
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.observedLogSpanMs, 12004);
  assert.deepEqual(
    report.steps.map((step) => step.intervalMs),
    [10000, 2004],
  );
  assert.equal(report.steps[1].boundary, "last log line (completion unknown)");
  assert.deepEqual(
    report.packages.map((p) => [p.package, p.reportedDurationMs, p.cached]),
    [
      ["@mend/a", 2500, false],
      ["@mend/b", 100, true],
    ],
  );
  assert.deepEqual(
    report.files.map((f) => [f.file, f.tests, f.reportedDurationMs, f.details]),
    [
      ["src/a.test.ts", 2, 1250, "| 1 skipped"],
      ["test/b.spec.tsx", 1, 80, "| 1 failed"],
    ],
  );
  assert.deepEqual(
    report.nodeTests.map((entry) => [entry.status, entry.file]),
    [
      ["passed", null],
      ["failed", null],
      ["skipped", null],
    ],
  );
  assert.equal(report.nodeRuns[0].reportedDurationMs, 1800.5);
});

test("does not invent missing package summaries or hide clock warnings and incomplete lines", (t) => {
  const child = run(t, [
    line(0, "##[group]Run pnpm test"),
    line(1, "##[endgroup]"),
    line(2, "##[group]@mend/interrupted:test"),
    line(3, "Warning: using time, but is not advancing the test clock"),
    "truncated or non-timestamped output",
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.packages[0].reportedDurationMs, null);
  assert.equal(report.files.length, 0);
  assert.equal(report.untimestampedLines, 1);
  assert.deepEqual(report.warnings, [{ kind: "unadvanced-test-clock", line: 4 }]);
});

test("absolute time shifts leave measured intervals unchanged", (t) => {
  for (const offset of [0, 1_700_000_000_000, 1_800_000_000_000]) {
    const child = run(t, [
      line(offset, "##[group]Run first"),
      line(offset + 1234, "##[group]Run second"),
      line(offset + 3000, "finished"),
    ]);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.deepEqual(
      report.steps.map((entry) => entry.intervalMs),
      [1234, 1766],
    );
    assert.equal(report.observedLogSpanMs, 3000);
  }
});

test("attributes an ungrouped failed Turbo task without borrowing a prior package summary", (t) => {
  const child = run(t, [
    line(0, "##[group]Run pnpm test"),
    line(1, "##[endgroup]"),
    line(2, "##[group]mend:test"),
    line(3, " Duration 10ms"),
    line(4, "##[endgroup]"),
    line(5, "@mend/api-server:test"),
    line(6, "##[group]nested diagnostic"),
    line(7, "##[endgroup]"),
    line(8, " ❯ src/route.test.ts (2 tests | 1 failed) 20ms"),
    line(9, " Duration 30ms"),
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(
    report.packages.map((p) => [p.package, p.reportedDurationMs]),
    [
      ["@mend/api-server", 30],
      ["mend", 10],
    ],
  );
  assert.equal(report.files[0].package, "@mend/api-server");
});

test("rejects unusable or backwards logs instead of reporting a zero-cost job", (t) => {
  for (const log of [[], ["a plain log"], [line(20, "##[group]Run test"), line(10, "done")]]) {
    const child = run(t, log);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /No timestamped GitHub Run groups|Timestamps go backwards/);
  }
});
