import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "ci-bounded.sh");

// 0.01 minutes is 0.6 s: long enough for `true`, far shorter than the stalls below.
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

test("a stalled command, its grandchildren too, is stopped at the bound and retried, then fails saying it stalled", () => {
  // The stall is in a grandchild, as apt-get under sudo under playwright-core.
  const result = bounded(["the download", "0.01", "2", "--", "sh", "-c", "sleep 30 & wait"]);
  assert.equal(result.status, 1);
  assert.ok(result.seconds < 10, `took ${String(result.seconds)} s, not two 0.6 s attempts`);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "::warning::the download stalled: it did not finish within 0.01 minutes (attempt 1 of 2)",
    "::warning::the download stalled: it did not finish within 0.01 minutes (attempt 2 of 2)",
    "::error::the download did not finish in 2 attempts of 0.01 minutes each; the warnings above say whether each stalled or failed",
  ]);
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
