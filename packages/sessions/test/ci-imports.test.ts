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
    // The same rule must apply when a package's own lint task starts in its directory.
    for (const cwd of [rootDirectory, path.dirname(testDirectory)]) {
      const result = spawnSync(process.execPath, [lintCli, "--format=json", ...rejectedPaths], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      for (const file of rejectedPaths) expect(result.stdout).toContain(path.basename(file));
      expect(result.stdout).toContain("replacement clocks keep the CI warning guard");
    }
    const allowed = path.join(directory, "allowed.ts");
    await writeFile(
      allowed,
      'import { TestClock } from "../effect-vitest.ts"; import * as FastCheck from "effect/testing/FastCheck"; import * as TestConsole from "effect/testing/TestConsole"; void [TestClock, FastCheck, TestConsole];',
    );
    const result = spawnSync(process.execPath, [lintCli, allowed], {
      cwd: rootDirectory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
