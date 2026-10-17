// Preloaded only into the `bench.mjs cleanup` children of live-cleanup-refusals.test.mjs. Each
// wait scenarios.mjs's own sleep() asks for (the Stop poll, the reconciliation grace, a retry's
// delay) is written to ST_BENCH_TEST_SLEEPS and taken at once. Every other timer (fetch's, the
// lock's) keeps its native clock, and the CLI's code is unchanged.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bench = fileURLToPath(new URL("../bench.mjs", import.meta.url));
if (process.argv[1] === bench && process.argv[2] === "cleanup") {
  const record = process.env.ST_BENCH_TEST_SLEEPS;
  assert.equal(typeof record, "string", "the virtual sleeps need their record file");
  const scenarios = new URL("../scenarios.mjs", import.meta.url).href;
  const native = globalThis.setTimeout;
  // `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))`: the frame that names
  // it is scenarios.mjs's own `sleep`, whoever called it.
  const fromSleep = () =>
    (new Error().stack ?? "").split("\n").some((line) => line.includes(`at sleep (${scenarios}:`));
  const virtual = (callback, delay, ...args) => {
    if (!fromSleep()) return native(callback, delay, ...args);
    appendFileSync(record, `${delay}\n`);
    return native(callback, 0, ...args);
  };
  virtual[promisify.custom] = native[promisify.custom];
  globalThis.setTimeout = virtual;
}
