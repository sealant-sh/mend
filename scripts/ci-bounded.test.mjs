import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-bounded.sh");

// 0.01 minutes is 0.6 s of silence: long enough for `true`, far shorter than the stalls below.
const bounded = (args) => {
  const started = Date.now();
  const result = spawnSync("bash", [script, ...args], { encoding: "utf8", timeout: 60_000 });
  return { ...result, seconds: (Date.now() - started) / 1000 };
};

test("a command that finishes is run once and passes quietly", () => {
  const result = bounded(["the download", "0.01", "3", "--", "true"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("a command that goes quiet, its grandchildren too, is stopped at the bound and retried, then fails saying it stalled", () => {
  // It prints, then the stall is in a grandchild, as apt-get under sudo under playwright-core.
  const result = bounded([
    "the download",
    "0.01",
    "2",
    "--",
    "sh",
    "-c",
    "echo fetching; sleep 30 & wait",
  ]);
  assert.equal(result.status, 1);
  assert.ok(result.seconds < 10, `took ${String(result.seconds)} s, not two 0.6 s silences`);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "fetching",
    "::warning::the download stalled: it printed nothing for 0.01 minutes (attempt 1 of 2)",
    "fetching",
    "::warning::the download stalled: it printed nothing for 0.01 minutes (attempt 2 of 2)",
    "::error::the download did not finish in 2 attempts; the warnings above say whether each stalled or failed",
  ]);
});

test("a slow command that keeps printing runs past the bound and passes on its first attempt", () => {
  // A slow mirror: a line every 0.5 s for about 4 s, longer in all than the 3 s bound (SLNT-1096).
  const result = bounded([
    "the download",
    "0.05",
    "1",
    "--",
    "sh",
    "-c",
    'for n in 1 2 3 4 5 6 7 8; do echo "Get:$n"; sleep 0.5; done',
  ]);
  assert.equal(result.status, 0);
  assert.ok(
    result.seconds > 3,
    `took ${String(result.seconds)} s, less than the bound it must outlast`,
  );
  assert.deepEqual(
    result.stdout.trim().split("\n"),
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Get:${String(n)}`),
  );
});

test("a command that fails once and then succeeds passes on its second attempt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-bounded-"));
  try {
    const marker = path.join(dir, "tried");
    const result = bounded([
      "the download",
      "0.01",
      "3",
      "--",
      "sh",
      "-c",
      `if [ -e "${marker}" ]; then exit 0; fi; touch "${marker}"; exit 7`,
    ]);
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout.trim(),
      "::warning::the download failed with exit code 7 (attempt 1 of 3)",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a call without the separator is refused", () => {
  const result = bounded(["the download", "0.01", "3", "true"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});
