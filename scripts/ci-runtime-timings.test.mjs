import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRuntimeTiming, summarizeRuntimeTimings } from "./ci-runtime-timings.mjs";

const base = { schemaVersion: 1, runner: "vitest", package: "@mend/example", runId: "run-a" };
const leaf = {
  ...base,
  kind: "test",
  id: "test-a",
  name: "dynamic budget",
  file: "test/a.test.ts",
  state: "passed",
  durationMs: 600,
  timeoutMs: 1000,
  retryCount: 0,
  repeatCount: 0,
};
const file = {
  ...base,
  kind: "file",
  file: "test/a.test.ts",
  state: "passed",
  durationMs: 700,
  budgetMs: 60000,
};
const summary = { ...base, kind: "summary", finished: true, files: 1, tests: 1 };
const encode = (record) => `CI_TIMING ${JSON.stringify(record)}`;

test("runtime records retain generated names, file identities and exact timing boundaries", () => {
  for (const name of ["plain", "Unicode λ ☃", 'quotes " and \\ paths', "newline\ninside name"])
    for (const durationMs of [0, 499.99, 500, 60000.01]) {
      const row = { ...leaf, name, durationMs };
      const parsed = parseRuntimeTiming(encode(row));
      assert.deepEqual(parsed, { kind: "record", value: row });
      const observed = summarizeRuntimeTimings([row], []);
      assert.equal(observed.tests[0].atLeastHalfTimeout, durationMs >= 500);
      assert.equal(observed.runs[0].complete, false);
    }
});

test("malformed or unsupported records cannot masquerade as trustworthy evidence", () => {
  assert.deepEqual(parseRuntimeTiming("a log mentioning CI_TIMING {}"), { kind: "absent" });
  for (const value of [
    null,
    [],
    {},
    { ...leaf, schemaVersion: 2 },
    { ...leaf, timeoutMs: "1000" },
    { ...leaf, durationMs: -1 },
    { ...file, budgetMs: null },
    { ...summary, files: 1.5 },
  ])
    assert.equal(parseRuntimeTiming(encode(value)).kind, "invalid");
  assert.equal(parseRuntimeTiming("CI_TIMING {truncated").kind, "invalid");
});

test("cached, unknown, skipped and aggregate attempt durations remain unassessed", () => {
  for (const overrides of [
    { cached: true },
    { timeoutMs: null },
    { timeoutMs: 0 },
    { durationMs: null },
    { state: "skipped" },
    { retryCount: 1 },
    { repeatCount: 1 },
    { runner: "node", timeoutMs: null, retryCount: null, repeatCount: null },
  ]) {
    const observed = summarizeRuntimeTimings([{ ...leaf, ...overrides }], []);
    assert.equal(observed.assessedCurrentLeaves, 0);
    assert.equal(observed.flaggedCurrentLeaves, 0);
    assert.equal(observed.unknownOrUnassessedLeaves, 1);
    assert.equal(observed.tests[0].ratio, null);
  }
});

test("completion requires matching counts in the same invocation", () => {
  const observed = summarizeRuntimeTimings(
    [
      leaf,
      file,
      summary,
      { ...leaf, runId: "run-b" },
      { ...summary, runId: "run-c" },
      { ...leaf, runId: "run-d" },
      { ...file, runId: "run-d" },
      { ...summary, runId: "run-d", finished: false },
    ],
    [],
  );
  assert.deepEqual(
    observed.runs.map((run) => [run.runId, run.complete]),
    [
      ["run-a", true],
      ["run-b", false],
      ["run-c", false],
      ["run-d", false],
    ],
  );
});

test("downloaded logs prefer runtime timeout evidence without double counting default output", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mend-runtime-timing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "job.log");
  const lines = [
    "##[group]Run pnpm test",
    "##[endgroup]",
    "##[group]@mend/example:test",
    " ✓ test/a.test.ts (1 test) 700ms",
    encode(leaf),
    encode(file),
    encode(summary),
    "##[endgroup]",
    "##[group]@mend/example:test",
    "cache hit, replaying logs",
    encode({ ...leaf, runId: "cached-run" }),
    "CI_TIMING {broken",
    "##[endgroup]",
  ];
  writeFileSync(path, lines.map((line, i) => `${new Date(i).toISOString()} ${line}`).join("\n"));
  const child = spawnSync(
    process.execPath,
    [new URL("./ci-timings.mjs", import.meta.url).pathname, path],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.files.length, 1);
  assert.equal(result.runtimeTimings.files.length, 1);
  assert.equal(result.runtimeTimings.assessedCurrentLeaves, 1);
  assert.equal(result.runtimeTimings.flaggedCurrentLeaves, 1);
  assert.equal(result.runtimeTimings.tests[1].cached, true);
  assert.equal(result.runtimeTimings.invalidRecords.length, 1);
});
