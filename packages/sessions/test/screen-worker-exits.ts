import { parentPort } from "node:worker_threads";

import type { WorkerRequest } from "../src/screen/screen-workers.ts";

/** The screen worker, except that its thread exits at the first request after a frame copy. */
let copied = false;
parentPort?.on("message", (request: WorkerRequest) => {
  if (copied) process.exit(1);
  copied = request._tag === "Copy";
});
await import("../src/screen/screen-worker.ts");
