import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { isRecord, runFixture } from "./fixture.ts";

const runner = "vitest";
for (const json of [false, true]) {
  void test(`${runner}: passing file retains ${json ? "JSON" : "default"} output and emits complete evidence`, async () => {
    const result = await runFixture({
      runner,
      json,
      source: 'import { it } from "vitest"; it("control\\u0085\\u2028\\u2029", () => {});',
    });
    assert.equal(new Set(result.records.map((record) => record["runId"])).size, 1);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    if (json) {
      const parsed = result.json;
      assert.ok(isRecord(parsed));
      assert.equal(parsed["numPassedTests"], 1);
    } else {
      assert.match(stripVTControlCharacters(result.stdout), /Test Files\s+1 passed/);
    }
    assert.equal(result.records.filter((r) => r["kind"] === "test").length, 1);
    assert.equal(
      result.records.find((r) => r["kind"] === "test")?.["name"],
      "control\u0085\u2028\u2029",
    );
    assert.doesNotMatch(result.stderr, /[\u0085\u2028\u2029]/);
    assert.equal(result.records.filter((r) => r["kind"] === "file").length, 1);
    const summary = result.records.find((r) => r["kind"] === "summary");
    assert.ok(summary);
    assert.equal(summary["finished"], true);
    assert.equal(summary["files"], 1);
    assert.equal(summary["tests"], 1);
    assert.equal(summary["collectedFiles"], 1);
    assert.equal(summary["collectedTests"], 1);
  });
}

void test(`${runner}: combined case duration exceeds a named file budget without changing case deadlines`, async () => {
  const result = await runFixture({
    runner,
    json: true,
    budgetMs: 100,
    source: `
import { it } from "vitest";
for (const name of ["first", "second", "third"]) it(name, async () => {
  await new Promise(resolve => setTimeout(resolve, 60));
});
`,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /CI file execution budget exceeded: @mend\/fixture guard.test.ts/);
  const cases = result.records.filter((r) => r["kind"] === "test");
  assert.equal(cases.length, 3);
  assert.ok(cases.every((r) => r["state"] === "passed" && r["timeoutMs"] === 5000));
  const file = result.records.find((r) => r["kind"] === "file");
  assert.ok(file);
  assert.equal(file["budgetMs"], 100);
  assert.ok(typeof file["durationMs"] === "number" && file["durationMs"] > 100);
});

void test(`${runner}: teardown hooks count toward file execution`, async () => {
  const result = await runFixture({
    runner,
    budgetMs: 50,
    source: `
import { afterAll, it } from "vitest";
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
it("short case", () => {});
`,
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /CI file execution budget exceeded: @mend\/fixture guard.test.ts/);
  assert.equal(result.records.find((r) => r["kind"] === "test")?.["state"], "passed");
});

void test(`${runner}: original case failures stay nonzero`, async () => {
  const result = await runFixture({
    runner,
    source:
      'import { it } from "vitest"; it("original refusal", () => { throw new Error("original failure"); });',
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /original failure/);
  assert.equal(result.records.find((r) => r["kind"] === "test")?.["state"], "failed");
  assert.doesNotMatch(result.stderr, /CI file execution budget exceeded/);
});

void test(`${runner}: runtime deadlines include dynamic, inherited, zero and infinite options`, async () => {
  const result = await runFixture({
    runner,
    json: true,
    source: `
import { describe, it } from "vitest";
const options = () => ({ timeout: 2300 });
it("dynamic", options(), () => {});
describe("inherited", { timeout: 2600 }, () => { it("child", () => {}); });
it("zero", { timeout: 0 }, () => {});
it("infinite", { timeout: Infinity }, () => {});
it.skip("skipped", () => {});
`,
  });
  assert.equal(result.code, 0, result.stderr);
  const cases = result.records.filter((r) => r["kind"] === "test");
  const dynamic = cases.find((r) => r["name"] === "dynamic");
  const inherited = cases.find((r) => r["name"] === "inherited > child");
  const zero = cases.find((r) => r["name"] === "zero");
  const infinite = cases.find((r) => r["name"] === "infinite");
  assert.ok(dynamic && inherited && zero && infinite);
  assert.equal(dynamic["timeoutMs"], 2300);
  assert.equal(inherited["timeoutMs"], 2600);
  assert.equal(dynamic["timeoutOrigin"], "runtime");
  assert.ok(typeof dynamic["headroomPercent"] === "number" && dynamic["headroomPercent"] >= 50);
  assert.equal(zero["timeoutMs"], 0);
  assert.equal(zero["timeoutReason"], "disabled");
  assert.equal(zero["headroomPercent"], null);
  assert.equal(infinite["timeoutMs"], null);
  assert.equal(infinite["timeoutReason"], "disabled");
  assert.equal(infinite["headroomPercent"], null);
  assert.equal(cases.find((r) => r["name"] === "skipped")?.["state"], "skipped");
});

void test(`${runner}: less than 50 percent headroom is reported without changing the exit status`, async () => {
  const result = await runFixture({
    runner,
    source: `
import { it } from "vitest";
it("observed low headroom", { timeout: 1800 }, async () => {
  await new Promise(resolve => setTimeout(resolve, 1000));
});
`,
  });
  assert.equal(result.code, 0, result.stderr);
  const record = result.records.find((r) => r["kind"] === "test");
  assert.ok(record);
  assert.equal(record["state"], "passed");
  assert.ok(typeof record["headroomPercent"] === "number" && record["headroomPercent"] < 50);
  assert.equal(record["headroomReason"], null);
});

void test(`${runner}: retries and repeats are labelled without assuming a per-attempt headroom`, async () => {
  const result = await runFixture({
    runner,
    source: `
import { it } from "vitest";
let attempts = 0;
it("retry", { retry: 1 }, () => { if (attempts++ === 0) throw new Error("retry once"); });
it("repeat", { repeats: 2 }, () => {});
`,
  });
  assert.equal(result.code, 0, result.stderr);
  for (const name of ["retry", "repeat"]) {
    const record = result.records.find((r) => r["kind"] === "test" && r["name"] === name);
    assert.ok(record);
    assert.equal(record["headroomPercent"], null);
    assert.equal(record["headroomReason"], "retried-or-repeated");
    assert.ok(typeof record[name === "retry" ? "retryCount" : "repeatCount"] === "number");
    assert.ok(Number(record[name === "retry" ? "retryCount" : "repeatCount"]) > 0);
  }
});

void test(`${runner}: CI_TEST_REPORT_DIR receives the package's Jest-compatible report, failures included`, async () => {
  const result = await runFixture({
    runner,
    json: true,
    report: { workspace: true },
    source: `
import { describe, it } from "vitest";
describe("group", () => { it("passes", () => {}); });
it("fails", () => { throw new Error("reported failure"); });
`,
  });
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(result.reports, [
    "retried-vitest-packages-fixture.json",
    "vitest-packages-fixture.json",
  ]);
  assert.ok(isRecord(result.json), "the package's own JSON output is still written");
  const report = result.report;
  assert.ok(isRecord(report) && Array.isArray(report["testResults"]));
  const [file]: ReadonlyArray<unknown> = report["testResults"];
  assert.ok(isRecord(file) && Array.isArray(file["assertionResults"]));
  assert.match(String(file["name"]), /^\/.*\/packages\/fixture\/guard\.test\.ts$/);
  assert.equal(file["status"], "failed");
  const { startTime, endTime } = file;
  assert.ok(typeof startTime === "number" && typeof endTime === "number");
  assert.ok(startTime > 0 && endTime >= startTime);
  assert.deepEqual(
    file["assertionResults"].map((entry: unknown) =>
      isRecord(entry) ? [entry["fullName"], entry["status"], typeof entry["duration"]] : entry,
    ),
    [
      ["group passes", "passed", "number"],
      ["fails", "failed", "number"],
    ],
  );
  // CI retried the failure once; failing again fails the run, and the retry is still recorded.
  assert.ok(Array.isArray(result.retried));
  assert.deepEqual(
    result.retried.map((entry: unknown) =>
      isRecord(entry) ? [entry["name"], entry["outcome"], entry["firstError"]] : entry,
    ),
    [["fails", "failed-twice", "reported failure"]],
  );
  assert.equal(result.summary, undefined, "a run that failed twice lists no flaky test");
});

void test(`${runner}: runs outside a pnpm workspace never write to an inherited report directory`, async () => {
  const result = await runFixture({
    runner,
    report: { workspace: false },
    source: 'import { it } from "vitest"; it("nested fixture", () => {});',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.reports, []);
});

void test(`${runner}: ordinary local runs retain output without timing evidence`, async () => {
  const result = await runFixture({
    runner,
    ci: "false",
    source: 'import { it } from "vitest"; it("local", () => {});',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.records.length, 0);
});

const flakyOnce = (firstAttempt: string, secondAttempt = "") => `
import { describe, it } from "vitest";
let attempts = 0;
describe("group", () => {
  it("flaky", async () => {
    if (attempts++ === 0) { ${firstAttempt} throw new Error("first attempt refused\\nsecond line"); }
    ${secondAttempt}
  });
  it("steady", () => {});
});
`;

void test(`${runner}: CI retries a failure once; a pass on the retry passes the run and is recorded`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mend-test-ci-event-"));
  try {
    const eventPath = join(directory, "event.json");
    await writeFile(eventPath, JSON.stringify({ pull_request: { head: { sha: "head-sha" } } }));
    const result = await runFixture({
      runner,
      report: { workspace: true },
      github: {
        GITHUB_JOB: "test-engines",
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: "merge-sha",
        GITHUB_EVENT_PATH: eventPath,
      },
      source: flakyOnce(""),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Array.isArray(result.retried));
    assert.equal(result.retried.length, 1, "a test that passed first time is not recorded");
    const [record] = result.retried;
    assert.ok(isRecord(record));
    const { attemptsMs, ...rest } = record;
    assert.deepEqual(rest, {
      schemaVersion: 1,
      package: "@mend/fixture",
      file: "packages/fixture/guard.test.ts",
      name: "group > flaky",
      outcome: "passed-on-retry",
      firstError: "first attempt refused second line",
      durationMs: rest["durationMs"],
      job: "test-engines",
      runId: "1234",
      runAttempt: "2",
      commit: "head-sha",
    });
    assert.ok(Array.isArray(attemptsMs) && attemptsMs.length === 2);
    assert.ok(attemptsMs.every((ms: unknown) => typeof ms === "number" && ms >= 0));
    assert.match(String(result.summary), /^### Flaky in this run: @mend\/fixture$/m);
    assert.match(
      String(result.summary),
      /^\| packages\/fixture\/guard\.test\.ts > group > flaky \| first attempt refused second line \| \d+ ms, \d+ ms \|$/m,
    );
    assert.doesNotMatch(String(result.summary), /steady/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test(`${runner}: ordinary local runs never retry, so a first failure still fails`, async () => {
  const result = await runFixture({
    runner,
    ci: "false",
    report: { workspace: true },
    source: flakyOnce(""),
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /first attempt refused/);
  assert.equal(result.retried, undefined);
});

const slow = "await new Promise((resolve) => setTimeout(resolve, 1_500));";

void test(`${runner}: the file budget does not charge the time of a retried test's failed attempt`, async () => {
  const result = await runFixture({
    runner,
    budgetMs: 1_000,
    source: flakyOnce(slow),
  });
  assert.equal(result.code, 0, result.stderr);
  const file = result.records.find((r) => r["kind"] === "file");
  assert.ok(file);
  assert.equal(file["budgetMs"], 1_000, "the budget itself is unchanged");
  assert.ok(Number(file["durationMs"]) > 1_500, "the file's own duration still includes the retry");
  assert.ok(Number(file["retriedAttemptsMs"]) >= 1_500);
  assert.ok(Number(file["budgetedMs"]) < 1_000);
});

void test(`${runner}: the attempt that counts is still charged against the file budget`, async () => {
  const result = await runFixture({
    runner,
    budgetMs: 1_000,
    source: flakyOnce("", slow),
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(
    result.stderr,
    /CI file execution budget exceeded: @mend\/fixture guard.test.ts took [\d.]+ ms \([\d.]+ ms without [\d.]+ ms of retried attempts\) > 1000 ms/,
  );
  const flaky = result.records.find((r) => r["kind"] === "test" && r["name"] === "group > flaky");
  assert.equal(flaky?.["state"], "passed");
});
