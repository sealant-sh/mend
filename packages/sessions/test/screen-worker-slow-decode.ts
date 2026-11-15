import { parentPort } from "node:worker_threads";

import type { WorkerRequest } from "../src/screen/screen-workers.ts";

/** Where this thread says it finished a decode that ran past the deadline. */
export const SLOW_DECODE_CHANNEL = "mend-screen-worker-slow-decode";

/** The screen worker, except that each decode takes longer than a decode may, then says so. */
parentPort?.on("message", (request: WorkerRequest) => {
  if (request._tag !== "Decode") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
  const channel = new BroadcastChannel(SLOW_DECODE_CHANNEL);
  channel.postMessage("finished");
  channel.close();
});
await import("../src/screen/screen-worker.ts");
