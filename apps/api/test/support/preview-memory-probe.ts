import { readFileSync } from "node:fs";

/**
 * Preloaded into a sampled child (`--import`): sends the parent this process's VmRSS and
 * `memoryUsage()` every `MEND_PREVIEW_MEMORY_INTERVAL_MS`, on its own timer, so a busy parent
 * delays only when samples are read, never when they are taken. Holds nothing open on its own.
 */
const intervalMs = Number(process.env["MEND_PREVIEW_MEMORY_INTERVAL_MS"] ?? 100);

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

sample();
setInterval(sample, intervalMs).unref();
process.channel?.unref();
