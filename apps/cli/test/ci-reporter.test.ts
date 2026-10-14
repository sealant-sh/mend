import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const vitestCli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const reporterPath = fileURLToPath(new URL("./ci-reporter.ts", import.meta.url));
const modulesPath = fileURLToPath(new URL("../node_modules", import.meta.url));

const runFixture = async (options: {
  readonly budgetMs: number;
  readonly body: string;
  readonly jsonReporter: boolean;
}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mend-cli-ci-guard-"));
  try {
    await symlink(modulesPath, path.join(directory, "node_modules"), "dir");
    await writeFile(
      path.join(directory, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";
import { cliCiGuard } from ${JSON.stringify(reporterPath)};
export default defineConfig({ plugins: [cliCiGuard({ fileBudgetMs: ${options.budgetMs} })] });
`,
    );
    await writeFile(
      path.join(directory, "guard.test.ts"),
      `import { it } from "vitest";
it("fixture", async () => { ${options.body} });
`,
    );
    const outputFile = path.join(directory, "report.json");
    const args = [vitestCli, "run", "guard.test.ts", "--maxWorkers=1"];
    if (options.jsonReporter) args.push("--reporter=json", `--outputFile=${outputFile}`);
    const result = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly output: string;
    }>((resolve, reject) => {
      // This bounds only the isolated runner's startup and shutdown, not CLI tests.
      const child = spawn(process.execPath, args, {
        cwd: directory,
        env: { ...process.env, CI: "true", FORCE_COLOR: "1", NO_COLOR: undefined },
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
for (const jsonReporter of [false, true]) {
  const reporter = jsonReporter ? "JSON override" : "default reporter";

  it(`fails the runner over its file budget with ${reporter}`, { timeout: 30_000 }, async () => {
    const result = await runFixture({
      budgetMs: 40,
      body: "await new Promise((resolve) => setTimeout(resolve, 120));",
      jsonReporter,
    });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain("CLI file execution budget exceeded:");
    expect(result.output).toContain("guard.test.ts");
    if (jsonReporter) {
      // Vitest 3's JSON success omits unhandled errors; the runner's exit is the failure oracle.
      expect(result.json).toMatchObject({
        numPassedTests: 1,
        testResults: [{ assertionResults: [{ status: "passed" }] }],
      });
    }
  });

  it(`passes a below-budget file and retains ${reporter}`, { timeout: 30_000 }, async () => {
    const result = await runFixture({ budgetMs: 10_000, body: "", jsonReporter });
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("CLI file execution budget exceeded:");
    if (jsonReporter) {
      expect(result.json).toMatchObject({ success: true, numPassedTests: 1 });
    } else {
      expect(result.output).toContain("\u001b[");
      expect(stripVTControlCharacters(result.output)).toMatch(/Test Files\s+1 passed/);
    }
  });
}
