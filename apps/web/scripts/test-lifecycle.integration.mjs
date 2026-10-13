import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

test("web tests release their runner resources before exit", { timeout: 45_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), "mend-web-test-lifecycle-"));
  try {
    const result = spawnSync(
      process.execPath,
      [vitest, "run", "src/lib/viewer.test.ts", "--reporter=default"],
      {
        cwd: webRoot,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_CACHE_HOME: join(home, "cache"),
          MEND_API_URL: "http://127.0.0.1:0",
          CI: "1",
          NO_COLOR: "1",
          // Keep CI's worker budget when this lifecycle check launches its own Vitest.
          VITEST_MAX_THREADS: process.env.VITEST_MAX_THREADS,
          VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS,
          VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS,
        },
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.ifError(result.error);
    assert.equal(result.signal, null, output);
    assert.equal(result.status, 0, output);
    assert.match(output, /5 passed/);
    assert.doesNotMatch(output, /close timed out|prevents Vite server from exiting/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
