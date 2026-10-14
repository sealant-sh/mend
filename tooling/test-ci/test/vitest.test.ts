import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const timingRecords = (stderr: string): ReadonlyArray<Record<string, unknown>> =>
  stripVTControlCharacters(stderr)
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith("CI_TIMING ")) return [];
      const record: unknown = JSON.parse(line.slice("CI_TIMING ".length));
      assert.ok(isRecord(record));
      assert.equal(record["schemaVersion"], 1);
      assert.equal(record["runner"], "vitest");
      assert.equal(typeof record["runId"], "string");
      return [record];
    });

const runFixture = async (options: {
  readonly runner: string;
  readonly source: string;
  readonly budgetMs?: number;
  readonly json?: boolean;
  readonly ci?: string;
}) => {
  const root = await mkdtemp(join(tmpdir(), "mend-test-ci-"));
  const runnerRoot = dirname(require.resolve(`${options.runner}/package.json`));
  try {
    await mkdir(join(root, "node_modules/@mend"), { recursive: true });
    await symlink(packageRoot, join(root, "node_modules/@mend/test-ci"), "dir");
    await symlink(runnerRoot, join(root, "node_modules/vitest"), "dir");
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(root, "vitest.config.ts"),
      `
import { defineConfig } from "vitest/config";
import { vitestCiGuard } from "@mend/test-ci/vitest";
export default defineConfig({ plugins: [vitestCiGuard({
  packageName: "@mend/fixture", fileBudgetMs: ${options.budgetMs ?? 10_000}
})] });
`,
    );
    await writeFile(join(root, "guard.test.ts"), options.source);
    const args = [join(runnerRoot, "vitest.mjs"), "run", "guard.test.ts", "--maxWorkers=1"];
    const outputFile = join(root, "report.json");
    if (options.json) args.push("--reporter=json", `--outputFile=${outputFile}`);
    const outcome = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: { ...process.env, CI: options.ci ?? "true", FORCE_COLOR: "1", NO_COLOR: undefined },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const json: unknown = options.json ? JSON.parse(await readFile(outputFile, "utf8")) : undefined;
    return { ...outcome, json, records: timingRecords(outcome.stderr) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

for (const runner of ["vitest", "vitest-v5"]) {
  for (const json of [false, true]) {
    test(`${runner}: passing file retains ${json ? "JSON" : "default"} output and emits complete evidence`, async () => {
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

  test(`${runner}: combined case duration exceeds a named file budget without changing case deadlines`, async () => {
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

  test(`${runner}: teardown hooks count toward file execution`, async () => {
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

  test(`${runner}: original case failures stay nonzero`, async () => {
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

  test(`${runner}: runtime deadlines include dynamic, inherited, zero and infinite options`, async () => {
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

  test(`${runner}: less than 50 percent headroom is reported without changing the exit status`, async () => {
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

  test(`${runner}: retries and repeats are labelled without assuming a per-attempt headroom`, async () => {
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

  test(`${runner}: ordinary local runs retain output without timing evidence`, async () => {
    const result = await runFixture({
      runner,
      ci: "false",
      source: 'import { it } from "vitest"; it("local", () => {});',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.records.length, 0);
  });
}
