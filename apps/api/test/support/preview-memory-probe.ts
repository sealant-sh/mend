import { readFileSync } from "node:fs";

/**
 * Preloaded into a sampled child (`--import`): sends the parent this process's VmRSS and
 * `memoryUsage()` every `MEND_PREVIEW_MEMORY_INTERVAL_MS`, on its own timer, so a busy parent
 * delays only when samples are read, never when they are taken. Holds nothing open on its own.
 * With `MEND_PREVIEW_MEMORY_COLLECT=1` (and `--expose-gc`) each sample follows two full
 * collections, so `arrayBuffers` counts what is still held rather than what awaits collection.
 */
const intervalMs = Number(process.env["MEND_PREVIEW_MEMORY_INTERVAL_MS"] ?? 100);
const collect = process.env["MEND_PREVIEW_MEMORY_COLLECT"] === "1";

const vmRss = (): number => {
  const line = readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("VmRSS:"));
  return Number(line?.split(/\s+/)[1] ?? Number.NaN) * 1024;
};

const sample = () => {
  const usage = process.memoryUsage();
  process.send?.({
    kind: "preview-memory",
    at: performance.timeOrigin + performance.now(),
    rss: vmRss(),
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    version: process.version,
  });
};

/**
 * V8 frees a dead buffer's memory on a background sweep after a full collection, so straight
 * after one `arrayBuffers` still counts up to an interval's worth of dead buffers (a fixed wait
 * for that sweep missed it on a loaded runner, SLNT-1174). A second full collection first
 * finishes the first one's sweep, and frees nothing still held.
 */
const tick = () => {
  if (collect) {
    globalThis.gc?.();
    globalThis.gc?.();
  }
  sample();
};

tick();
setInterval(tick, intervalMs).unref();
process.channel?.unref();
