import { parentPort } from "node:worker_threads";

import type { WorkerRequest } from "../src/screen/screen-workers.ts";

/** The screen worker, except that its thread exits on its own soon after its first frame copy. */
parentPort?.on("message", (request: WorkerRequest) => {
  if (request._tag === "Copy") setTimeout(() => process.exit(1), 100);
});
await import("../src/screen/screen-worker.ts");
