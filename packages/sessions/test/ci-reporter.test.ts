import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const vitestCli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const reporterPath = fileURLToPath(new URL("./ci-reporter.ts", import.meta.url));
const modulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));

const runFixture = async (options: {
  readonly budgetMs: number;
  readonly testName: string;
  readonly body: string;
  readonly jsonReporter: boolean;
}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-sessions-ci-guard-"));
  try {
    await symlink(modulesPath, path.join(directory, "node_modules"), "dir");
    await writeFile(
      path.join(directory, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";
import { sessionsCiGuard } from ${JSON.stringify(reporterPath)};
export default defineConfig({ plugins: [sessionsCiGuard({ fileBudgetMs: ${options.budgetMs} })] });
`,
    );
    await writeFile(
      path.join(directory, "guard.test.ts"),
      `import { it } from "vitest";
it(${JSON.stringify(options.testName)}, async () => { ${options.body} });
`,
    );
    const outputFile = path.join(directory, "report.json");
    const args = [vitestCli, "run", "guard.test.ts"];
    if (options.jsonReporter) args.push("--reporter=json", `--outputFile=${outputFile}`);
    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly output: string;
    }>((resolve, reject) => {
      // This bounds only the isolated runner's startup and shutdown, not any sessions test.
      const child = spawn(process.execPath, args, {
        cwd: directory,
        env: { ...process.env, CI: "true" },
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        output += text;
      });
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        output += text;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, output }));
    });
    const json: unknown = options.jsonReporter
      ? JSON.parse(await readFile(outputFile, "utf8"))
      : undefined;
    return { ...result, json };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Each case starts a real isolated Vitest process; allow its bounded startup and shutdown.
it(
  "fails the runner on file execution budget even with a JSON reporter override",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 40,
      testName: "slow file",
      body: "await new Promise((resolve) => setTimeout(resolve, 120));",
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("sessions file execution budget exceeded:");
    expect(result.output).toContain("guard.test.ts");
    // Vitest 3's JSON success omits unhandled errors; the runner's exit is the failure oracle.
    expect(result.json).toMatchObject({
      numPassedTests: 1,
      testResults: [{ assertionResults: [{ status: "passed" }] }],
    });
  },
);

it(
  "fails the runner on a Clock warning and identifies its file and test with JSON output",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "clock warning owner",
      body: 'console.warn("Warning: A test is using time, but is not advancing the test clock.");',
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("sessions Clock warning:");
    expect(result.output).toContain("guard.test.ts > clock warning owner");
    expect(result.json).toMatchObject({
      numPassedTests: 1,
      testResults: [{ assertionResults: [{ status: "passed" }] }],
    });
  },
);

it(
  "passes a below-budget file with an unrelated warning and retains JSON output",
  { timeout: 30_000 },
  async () => {
    const result = await runFixture({
      budgetMs: 10_000,
      testName: "ordinary warning",
      body: 'console.warn("ordinary fixture warning");',
      jsonReporter: true,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ success: true, numPassedTests: 1 });
  },
);

it("retains the default reporter for a passing file", { timeout: 30_000 }, async () => {
  const result = await runFixture({
    budgetMs: 10_000,
    testName: "default reporter control",
    body: "",
    jsonReporter: false,
  });
  expect(result.signal).toBeNull();
  expect(result.code).toBe(0);
  expect(result.output).toMatch(/Test Files\s+1 passed/);
});
