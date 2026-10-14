import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const isRecord = (value: unknown): value is Record<string, unknown> =>
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

export const runFixture = async (options: {
  readonly runner: string;
  readonly source: string;
  readonly budgetMs?: number;
  readonly json?: boolean;
  readonly ci?: string;
  /** Sets CI_TEST_REPORT_DIR. A workspace fixture is packages/fixture under pnpm-workspace.yaml. */
  readonly report?: { readonly workspace: boolean };
  /** Packages linked beside the runner, resolved from this package, for fixtures that import them. */
  readonly modules?: ReadonlyArray<string>;
}) => {
  const root = await mkdtemp(join(tmpdir(), "mend-test-ci-"));
  const project = options.report?.workspace ? join(root, "packages/fixture") : root;
  const reportDir = join(root, "reports");
  const runnerRoot = dirname(require.resolve(`${options.runner}/package.json`));
  try {
    if (options.report?.workspace) await writeFile(join(root, "pnpm-workspace.yaml"), "");
    await mkdir(join(project, "node_modules/@mend"), { recursive: true });
    await symlink(packageRoot, join(project, "node_modules/@mend/test-ci"), "dir");
    await symlink(runnerRoot, join(project, "node_modules/vitest"), "dir");
    for (const name of options.modules ?? []) {
      const target = join(project, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(dirname(require.resolve(`${name}/package.json`)), target, "dir");
    }
    await writeFile(join(project, "package.json"), '{"type":"module"}\n');
    await writeFile(
      join(project, "vitest.config.ts"),
      `
import { defineConfig } from "vitest/config";
import { vitestCiGuard } from "@mend/test-ci/vitest";
export default defineConfig({ plugins: [vitestCiGuard({
  packageName: "@mend/fixture", fileBudgetMs: ${options.budgetMs ?? 10_000}
})] });
`,
    );
    await writeFile(join(project, "guard.test.ts"), options.source);
    const args = [join(runnerRoot, "vitest.mjs"), "run", "guard.test.ts", "--maxWorkers=1"];
    const outputFile = join(project, "report.json");
    if (options.json) args.push("--reporter=json", `--outputFile=${outputFile}`);
    const outcome = await new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: project,
        env: {
          ...process.env,
          CI: options.ci ?? "true",
          FORCE_COLOR: "1",
          NO_COLOR: undefined,
          ...(options.report ? { CI_TEST_REPORT_DIR: reportDir } : {}),
        },
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
    const reports = await readdir(reportDir).catch(() => []);
    const [reportFile] = reports;
    const report: unknown =
      reportFile === undefined
        ? undefined
        : JSON.parse(await readFile(join(reportDir, reportFile), "utf8"));
    return { ...outcome, json, reports, report, records: timingRecords(outcome.stderr) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
