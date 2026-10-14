import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = (name) => join(root, "scripts/fixtures/ci-test-report", name);

const run = async (reportDir) => {
  const directory = await mkdtemp(join(tmpdir(), "mend-ci-test-report-"));
  const env = { ...process.env, CI_TEST_REPORT_DIR: reportDir?.(directory) };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=./scripts/ci-test-report.mjs",
        "--test-reporter-destination=stdout",
        fixture("timed.mjs"),
        fixture("nested.mjs"),
      ],
      { cwd: root, env, encoding: "utf8", timeout: 20_000 },
    );
    const reports = await readdir(directory, { recursive: true });
    const contents = await Promise.all(
      reports
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))),
    );
    return { result, reports, contents };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("a failing run writes one Jest-compatible report with per-file spans and nested names", async () => {
  const { result, reports, contents } = await run((directory) => join(directory, "nested/dir"));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(reports, [
    "nested",
    "nested/dir",
    "nested/dir/node-scripts-fixtures-ci-test-report-nested.mjs.json",
  ]);
  const [report] = contents;
  assert.equal(report.success, false);
  assert.equal(report.numTotalTests, 7);
  assert.equal(report.numFailedTests, 1);
  const byName = new Map(report.testResults.map((file) => [file.name, file]));
  assert.deepEqual([...byName.keys()].toSorted(), [fixture("nested.mjs"), fixture("timed.mjs")]);
  for (const file of report.testResults) {
    assert.ok(Number.isInteger(file.startTime) && file.startTime >= report.startTime, file.name);
    assert.ok(file.endTime >= file.startTime, file.name);
    for (const assertion of file.assertionResults) {
      assert.ok(typeof assertion.duration === "number" && assertion.duration >= 0);
    }
  }
  const timed = byName.get(fixture("timed.mjs"));
  assert.equal(timed.status, "passed");
  assert.ok(timed.endTime - timed.startTime >= 50, "the file span covers its slow test");
  assert.ok(timed.assertionResults[0].duration >= 50);
  const nested = byName.get(fixture("nested.mjs"));
  assert.equal(nested.status, "failed");
  assert.deepEqual(
    nested.assertionResults.map(({ fullName, title, ancestorTitles, status }) => ({
      fullName,
      title,
      ancestorTitles,
      status,
    })),
    [
      { fullName: "suite > inner", title: "inner", ancestorTitles: ["suite"], status: "passed" },
      {
        fullName: "suite > skipped",
        title: "skipped",
        ancestorTitles: ["suite"],
        status: "skipped",
      },
      { fullName: "suite > pending", title: "pending", ancestorTitles: ["suite"], status: "todo" },
      { fullName: "top > child", title: "child", ancestorTitles: ["top"], status: "passed" },
      { fullName: "top", title: "top", ancestorTitles: [], status: "passed" },
      { fullName: "fails", title: "fails", ancestorTitles: [], status: "failed" },
    ],
  );
  assert.deepEqual(nested.assertionResults.at(-1).failureMessages, ["boom"]);
});

test("without CI_TEST_REPORT_DIR the reporter stays silent and the run is unchanged", async () => {
  const { result } = await run(() => undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
});
