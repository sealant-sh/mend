import { SealantWorkspaceId } from "@mend/domain";
import { forwardSockets, portTarget } from "@mend/sessions";
import { ManagedRuntime } from "effect";
import { afterEach, expect, it } from "vitest";

import { spawnFixture } from "./fixtures/preview/apps.ts";
import { localForwards } from "./support/preview-forward.ts";

const WORKSPACE = SealantWorkspaceId.make("ws-memory");
const PAYLOAD = 256 * 1024 * 1024;
const MiB = 1024 * 1024;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stalledDownloadGrowth = async (unbounded: boolean) => {
  const app = await spawnFixture("download");
  disposers.push(app.stop);
  const forwards = localForwards(
    [{ workspaceId: WORKSPACE, port: 8080, entry: { kind: "listen", localPort: app.port } }],
    { unbounded },
  );
  const runtime = ManagedRuntime.make(forwards.layer);
  disposers.push(() => runtime.dispose());
  const connect = await runtime.runPromise(forwardSockets);

  await sleep(200);
  const baseline = process.memoryUsage().arrayBuffers;
  const socket = connect(portTarget(WORKSPACE, 8080), { purpose: "benchmark" });
  disposers.push(async () => {
    socket.destroy();
  });
  const first = Promise.withResolvers<string>();
  socket.once("data", (chunk: Buffer) => {
    socket.pause();
    first.resolve(chunk.subarray(0, 12).toString("latin1"));
  });
  socket.write(`GET /bytes?n=${PAYLOAD} HTTP/1.1\r\nHost: localhost\r\n\r\n`);

  let peak = 0;
  let last = 0;
  let stableSince = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(100);
    const growth = process.memoryUsage().arrayBuffers - baseline;
    peak = Math.max(peak, growth);
    if (Math.abs(growth - last) > 256 * 1024) stableSince = Date.now();
    last = growth;
    if (Date.now() - stableSince >= 2_000) break;
  }
  return { peak, head: await first.promise };
};

it("a stalled reader holds a bounded forward to a few MiB, and the unbounded one to the payload", async () => {
  const bounded = await stalledDownloadGrowth(false);
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
  const unbounded = await stalledDownloadGrowth(true);
  process.stderr.write(
    `256 MiB stalled download: bounded peak arrayBuffers growth ${(bounded.peak / MiB).toFixed(2)} MiB, unbounded ${(unbounded.peak / MiB).toFixed(2)} MiB (node ${process.version})\n`,
  );
  expect([bounded.head, unbounded.head], "both downloads started").toEqual([
    "HTTP/1.1 200",
    "HTTP/1.1 200",
  ]);
  expect(bounded.peak, "bounded: arrayBuffers growth stays under 4 MiB").toBeLessThan(4 * MiB);
  expect(unbounded.peak, "unbounded: grows by most of the payload").toBeGreaterThan(0.75 * PAYLOAD);
});
