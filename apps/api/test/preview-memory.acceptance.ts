import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { type SampledChild, spawnSampled } from "./support/preview-memory.ts";

const MiB = 1024 * 1024;
const SERVE = fileURLToPath(new URL("./fixtures/preview/serve.ts", import.meta.url));

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

const sampled = (modulePath: string, args: ReadonlyArray<string>): SampledChild => {
  const sampler = spawnSampled(modulePath, args);
  disposers.push(sampler.stop);
  return sampler;
};

it("samples a child every 100 ms and sees what it allocates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mend-preview-memory-"));
  disposers.push(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, "allocate.mjs");
  await writeFile(
    script,
    `const held = [];
process.on("message", (message) => {
  if (message?.allocate) held.push(Buffer.alloc(message.allocate, 1));
});
console.log("ready");
setInterval(() => held.length, 1000);
`,
  );
  const sampler = sampled(script, []);
  await sampler.line((line) => line === "ready");
  const base = await sampler.baseline();
  sampler.child.send({ allocate: 96 * MiB });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && sampler.peak().arrayBuffers - base.arrayBuffers < 90 * MiB) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  const peak = sampler.peak();
  const times = sampler.samples().map((sample) => sample.t);
  const gaps = times.slice(1).map((t, index) => t - (times[index] ?? 0));
  const median = gaps.toSorted((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
  process.stderr.write(
    `sampler: ${times.length} samples, median gap ${median.toFixed(1)} ms, rss ${(base.rss / MiB).toFixed(1)} -> ${(peak.rss / MiB).toFixed(1)} MiB, arrayBuffers +${((peak.arrayBuffers - base.arrayBuffers) / MiB).toFixed(1)} MiB, child ${sampler.nodeVersion()}\n`,
  );
  expect(median, "samples about 100 ms apart").toBeGreaterThan(80);
  expect(median, "samples about 100 ms apart").toBeLessThan(150);
  expect(peak.rss - base.rss, "VmRSS sees the touched 96 MiB").toBeGreaterThan(90 * MiB);
  expect(peak.arrayBuffers - base.arrayBuffers, "the probe sees the 96 MiB buffer").toBeGreaterThan(
    90 * MiB,
  );
  expect(sampler.nodeVersion(), "the child runs this Node").toBe(process.version);
});

it("samples a fixture server child and reads its port line", async () => {
  const sampler = sampled(SERVE, ["download"]);
  const line = await sampler.line((next) => next.startsWith("{"));
  const port: unknown = JSON.parse(line).port;
  expect(typeof port, "the fixture printed its port").toBe("number");
  const base = await sampler.baseline();
  const response = await fetch(`http://127.0.0.1:${String(port)}/bytes?n=${2048 * MiB}`);
  let received = 0;
  const started = Date.now();
  for await (const chunk of response.body ?? []) received += chunk.length;
  const servedMs = Date.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const peak = sampler.peak();
  const during = sampler
    .samples()
    .filter((sample) => sample.t > base.t && sample.t < base.t + servedMs).length;
  process.stderr.write(
    `download child: 2 GiB served in ${servedMs} ms, ${during} samples, rss ${(base.rss / MiB).toFixed(1)} -> ${(peak.rss / MiB).toFixed(1)} MiB\n`,
  );
  expect(received, "the whole download").toBe(2048 * MiB);
  expect(during, "sampled while it served").toBeGreaterThanOrEqual(Math.floor(servedMs / 100) - 2);
  expect(peak.rss - base.rss, "a generated download never holds the payload").toBeLessThan(
    32 * MiB,
  );
});
