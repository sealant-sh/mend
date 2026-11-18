import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lintCli = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin/oxlint");
const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const rootDirectory = fileURLToPath(new URL("../../..", import.meta.url));

interface LintDiagnostic {
  readonly filename: string;
  readonly message: string;
  readonly help?: string;
}

// Each oxlint process loads every JS plugin the config names, so each test lints all its probes in
// as few processes as its claim allows: process start-up, not linting, is what these tests pay for.
const lint = (cwd: string, files: ReadonlyArray<string>) => {
  const result = spawnSync(process.execPath, [lintCli, "--format=json", ...files], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const report: { diagnostics: ReadonlyArray<LintDiagnostic> } = JSON.parse(result.stdout);
  const diagnosticsOf = (file: string) =>
    report.diagnostics.filter((entry) => path.resolve(cwd, entry.filename) === file);
  return { result, diagnosticsOf };
};

it("rejects raw clock imports and allows guarded clocks plus unrelated test services", async () => {
  const directory = await mkdtemp(path.join(testDirectory, ".clock-import-probe-"));
  try {
    const rejected: ReadonlyArray<readonly [string, string]> = [
      ["named.ts", 'import { TestClock } from "effect/testing"; void TestClock;'],
      ["alias.ts", 'import { TestClock as Clock } from "effect/testing"; void Clock;'],
      ["namespace.ts", 'import * as Testing from "effect/testing"; void Testing.TestClock;'],
      ["reexport.ts", 'export { TestClock } from "effect/testing";'],
      ["star.ts", 'export * from "effect/testing";'],
      ["dynamic.ts", 'void import("effect/testing").then(({ TestClock }) => TestClock);'],
      ["subpath.ts", 'import * as Clock from "effect/testing/TestClock"; void Clock;'],
      ["dynamic-subpath.ts", 'void import("effect/testing/TestClock");'],
      ["extension.ts", 'export { make } from "effect/testing/TestClock.js";'],
      ["index.ts", 'export * from "effect/testing/index";'],
    ];
    const rejectedPaths: string[] = [];
    for (const [name, source] of rejected) {
      const file = path.join(directory, name);
      await writeFile(file, source);
      rejectedPaths.push(file);
    }
    const allowed = path.join(directory, "allowed.ts");
    await writeFile(
      allowed,
      'import { TestClock } from "@mend/test-ci/effect-vitest"; import * as FastCheck from "effect/testing/FastCheck"; import * as TestConsole from "effect/testing/TestConsole"; void [TestClock, FastCheck, TestConsole];',
    );
    // The same rule must apply when a package's own lint task starts in its directory.
    for (const cwd of [rootDirectory, path.dirname(testDirectory)]) {
      const { result, diagnosticsOf } = lint(cwd, [...rejectedPaths, allowed]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      for (const file of rejectedPaths) {
        const found = diagnosticsOf(file);
        expect(found.length, `${path.basename(file)} passed lint from ${cwd}`).toBeGreaterThan(0);
        expect(JSON.stringify(found)).toContain("replacement clocks keep the CI warning guard");
      }
      expect(diagnosticsOf(allowed), `allowed.ts from ${cwd}`).toEqual([]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects raw clock imports in every package whose Effect tests run on a guard", async () => {
  const guarded: ReadonlyArray<readonly [string, string]> = [
    ["packages/sessions/test", "@mend/test-ci/effect-vitest"],
    ["packages/db/test", "@mend/test-ci/effect-vitest"],
    ["packages/jobs/test", "@mend/test-ci/effect-vitest"],
    ["packages/store/test", "@mend/test-ci/effect-vitest"],
    ["apps/api/test", "@mend/test-ci/effect-vitest"],
    ["apps/t3-gateway/test", "test/support/effect-vitest.ts"],
  ];
  // Every file type a test or helper can be, every way to reach the raw modules.
  const probes: ReadonlyArray<readonly [string, string]> = [
    ["clock.ts", 'import { TestClock } from "effect/testing"; void TestClock;'],
    ["vitest.ts", 'import { it } from "@effect/vitest"; void it;'],
    ["clock.test.tsx", 'import { TestClock } from "effect/testing"; void TestClock;'],
    ["vitest.test.tsx", 'import { it } from "@effect/vitest"; void it;'],
    ["clock.mts", 'import { TestClock } from "effect/testing"; void TestClock;'],
    ["clock.cts", 'import { TestClock } from "effect/testing"; void TestClock;'],
    ["clock.mjs", 'import { TestClock } from "effect/testing"; void TestClock;'],
    ["subpath.ts", 'import { it } from "@effect/vitest/index"; void it;'],
    ["required.ts", 'const { TestClock } = require("effect/testing"); void TestClock;'],
    ["required.cjs", 'const vitest = require("@effect/vitest"); void vitest;'],
  ];
  const directories: string[] = [];
  try {
    const packages: Array<{ packageTests: string; guard: string; files: string[] }> = [];
    for (const [packageTests, guard] of guarded) {
      // A dot directory: package lint tasks never walk into it, so a parallel lint stays clean.
      const directory = await mkdtemp(
        path.join(rootDirectory, packageTests, ".clock-import-probe-"),
      );
      directories.push(directory);
      const files: string[] = [];
      for (const [name, source] of probes) {
        const file = path.join(directory, name);
        await writeFile(file, source);
        files.push(file);
      }
      packages.push({ packageTests, guard, files });
    }
    const { result, diagnosticsOf } = lint(
      rootDirectory,
      packages.flatMap((entry) => entry.files),
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    for (const { packageTests, guard, files } of packages) {
      const found = files.map((file) => {
        const diagnostics = diagnosticsOf(file);
        expect(
          diagnostics.length,
          `${packageTests}/${path.basename(file)} passed lint`,
        ).toBeGreaterThan(0);
        return diagnostics;
      });
      expect(JSON.stringify(found), packageTests).toContain(guard);
    }
  } finally {
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});
