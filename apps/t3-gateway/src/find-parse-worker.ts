import { parentPort } from "node:worker_threads";

import { parseSegments, type ParseRequest } from "./find-parse.ts";

parentPort?.on("message", (request: ParseRequest) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, which has no origin.
  parentPort?.postMessage(parseSegments(request));
});
