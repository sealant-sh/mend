import { parentPort, workerData } from "node:worker_threads";

import { checkPage } from "./page-check.ts";

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, which has no origin.
parentPort?.postMessage(checkPage(workerData));
