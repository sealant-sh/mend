import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import {
  captureCheckout,
  checkoutOf,
  machineName,
  scratchParentRefusal,
  type Refused,
  type CapturedCheckout,
  type GitRuntime,
} from "@mend/local-git/handoff";
import { Option, Schema } from "effect";

import {
  WorkerCommand,
  WorkerConfiguration,
  type WorkerResult,
  type WorkerJob,
} from "./handoff-protocol.js";

const stopped = (words: string): Refused => ({
  _tag: "refused",
  why: { reason: "git", words },
  message: words,
});
const configuration = Schema.decodeUnknownSync(WorkerConfiguration)(workerData);
const port = parentPort;
if (port === null) throw new Error("A handoff worker needs its parent.");
let capture: CapturedCheckout | null = null;
let cancel = new Int32Array(new SharedArrayBuffer(4));
let deadline = 0;
const runtime: GitRuntime = {
  git: configuration.git,
  timeoutMs: configuration.timeoutMs,
  cancelled: () => Atomics.load(cancel, 0) !== 0 || Date.now() >= deadline,
};
const dispose = () => {
  capture?.dispose();
  capture = null;
  fs.rmSync(configuration.scratch, { recursive: true, force: true });
};
const run = (job: WorkerJob): WorkerResult => {
  switch (job.kind) {
    case "dispose":
      dispose();
      return { _tag: "disposed" };
    case "discover":
      return checkoutOf(configuration.checkout, runtime);
    case "pack":
      return capture?.pack() ?? stopped("The snapshot is no longer available. Try again.");
    case "capture": {
      dispose();
      const found = checkoutOf(configuration.checkout, runtime);
      if (found._tag !== "checkout") return found;
      const issue = scratchParentRefusal(path.dirname(configuration.scratch), found.checkout);
      if (issue !== null) return issue;
      fs.mkdirSync(configuration.scratch, { mode: 0o700 });
      const result = captureCheckout({
        checkout: found.checkout.top,
        defaultBranch: job.defaultBranch,
        maxFileBytes: job.fileBytes,
        envFiles: job.envFiles,
        cutAt: new Date(job.cutAt),
        scratchParent: configuration.scratch,
        machine: machineName(),
        runtime,
      });
      if (result._tag !== "captured") {
        dispose();
        return result;
      }
      capture = result.capture;
      return { _tag: "captured", summary: capture.summary };
    }
  }
};
const readCommand = Schema.decodeUnknownOption(WorkerCommand);
port.on("message", (value: unknown) => {
  const command = readCommand(value);
  const flag: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "cancel") : null;
  if (Option.isNone(command) || !(flag instanceof SharedArrayBuffer) || flag.byteLength !== 4) {
    dispose();
    port.close();
    return;
  }
  cancel = new Int32Array(flag);
  deadline = Date.now() + configuration.deadlineMs;
  let result: WorkerResult;
  try {
    result = run(command.value.job);
    if (result._tag === "cancelled" && Atomics.load(cancel, 0) === 0)
      result = {
        _tag: "refused",
        why: { reason: "timed-out", words: "Reading this checkout took too long. Try again." },
        message: "Reading this checkout took too long. Try again.",
      };
  } catch {
    dispose();
    result = stopped(
      "Mend could not prepare the snapshot. Check that Git and the temporary directory are available, then try again.",
    );
  }
  port.postMessage({ id: command.value.id, result });
  if (command.value.job.kind === "dispose") port.close();
});
