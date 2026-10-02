import * as os from "node:os";
import { Worker } from "node:worker_threads";

/**
 * Pack payload verification off the server's thread.
 *
 * A sealing register reads every pack its capture lists and checks every chunk in it: the pack
 * hashes to its key, each chunk decompresses to the size its index states and hashes to the chunk
 * it names. For a first save of a repository with its dependencies that is a few gigabytes of
 * zstd and SHA-256, and on the server's own thread it held a Stop for 20 seconds and every other
 * request with it (2026-10-02, 788 MB of packs). The checks are the same here; they run on worker
 * threads, several packs at a time.
 *
 * The worker is given the pack's bytes and its index entries, already decoded and bounds-checked
 * by the caller, and answers what it found. It decides nothing about what a finding means.
 */

/** One index entry as the worker needs it. */
export interface PackVerifyEntry {
  readonly hash: string;
  readonly offset: number;
  readonly length: number;
  readonly size: number;
}

/** What the worker found wrong with a pack, in the terms `captures.ts` raises it. */
export type PackVerifyProblem =
  | { readonly tag: "integrity"; readonly expected: string; readonly actual: string }
  | { readonly tag: "format"; readonly reason: string };

/** How many packs are verified at once: each holds one pack (64 MiB) and its largest chunk. */
export const PACK_VERIFY_WORKERS = Math.max(1, Math.min(4, os.availableParallelism() - 1));

/**
 * The worker's program. Plain JavaScript in a string, as the workspace programs are: it runs
 * under `node` with nothing bundled and nothing resolved from disk.
 */
const WORKER_PROGRAM = `
const { parentPort } = require("node:worker_threads");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const verify = (expected, entries, pack) => {
  if (expected !== null) {
    const actual = sha256(pack);
    if (actual !== expected) return { tag: "integrity", expected, actual };
  }
  for (const entry of entries) {
    let bytes;
    try {
      bytes = zlib.zstdDecompressSync(pack.subarray(entry.offset, entry.offset + entry.length), {
        maxOutputLength: Math.max(1, entry.size),
      });
    } catch (cause) {
      return { tag: "format", reason: "chunk " + entry.hash + ": " + (cause instanceof Error ? cause.message : String(cause)) };
    }
    if (bytes.byteLength !== entry.size) {
      return { tag: "format", reason: "chunk " + entry.hash + ": size " + bytes.byteLength + ", index says " + entry.size };
    }
    const actual = sha256(bytes);
    if (actual !== entry.hash) return { tag: "integrity", expected: entry.hash, actual };
  }
  return null;
};
parentPort.on("message", ({ id, expected, entries, pack }) => {
  let problem;
  try {
    problem = verify(expected, entries, Buffer.from(pack));
  } catch (cause) {
    parentPort.postMessage({ id, crashed: cause instanceof Error ? cause.message : String(cause) });
    return;
  }
  parentPort.postMessage({ id, problem });
});
`;

interface Job {
  readonly id: number;
  readonly expected: string | null;
  readonly entries: ReadonlyArray<PackVerifyEntry>;
  readonly pack: ArrayBuffer;
  readonly resolve: (problem: PackVerifyProblem | null) => void;
  readonly reject: (error: Error) => void;
}

interface Slot {
  readonly worker: Worker;
  job: Job | null;
}

const slots: Array<Slot> = [];
const waiting: Array<Job> = [];
let nextId = 0;

const dispatch = (): void => {
  for (const slot of slots) {
    if (slot.job !== null) continue;
    const job = waiting.shift();
    if (job === undefined) return;
    slot.job = job;
    slot.worker.postMessage(
      { id: job.id, expected: job.expected, entries: job.entries, pack: job.pack },
      [job.pack],
    );
  }
};

const retire = (slot: Slot, error: Error): void => {
  const at = slots.indexOf(slot);
  if (at !== -1) slots.splice(at, 1);
  const job = slot.job;
  slot.job = null;
  if (job !== null) job.reject(error);
  void slot.worker.terminate();
};

const spawn = (): void => {
  const worker = new Worker(WORKER_PROGRAM, { eval: true });
  // A worker never keeps the server alive.
  worker.unref();
  const slot: Slot = { worker, job: null };
  worker.on(
    "message",
    (answer: {
      readonly id: number;
      readonly problem?: PackVerifyProblem | null;
      readonly crashed?: string;
    }) => {
      const job = slot.job;
      if (job === null || job.id !== answer.id) return;
      slot.job = null;
      if (answer.crashed === undefined) job.resolve(answer.problem ?? null);
      else job.reject(new Error(answer.crashed));
      dispatch();
    },
  );
  worker.on("error", (error) => retire(slot, error));
  worker.on("exit", () => retire(slot, new Error("the pack verification worker exited")));
  slots.push(slot);
};

/**
 * Verify one pack on a worker thread: `pack` hashes to `expected` (when the key names a digest),
 * and every entry decompresses to its size and hashes to its chunk. Null when it does. `pack`'s
 * buffer is handed to the worker and is not usable afterwards. Rejects when the worker could not
 * run the check, which says nothing about the pack: the caller verifies it itself then.
 */
export const verifyPackOnWorker = (
  expected: string | null,
  entries: ReadonlyArray<PackVerifyEntry>,
  pack: ArrayBuffer,
): Promise<PackVerifyProblem | null> =>
  new Promise((resolve, reject) => {
    try {
      // One worker per pack in hand, up to the limit.
      const busy = slots.filter((slot) => slot.job !== null).length;
      const wanted = Math.min(PACK_VERIFY_WORKERS, busy + waiting.length + 1);
      while (slots.length < wanted) spawn();
    } catch (error) {
      if (slots.length === 0) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    nextId += 1;
    waiting.push({ id: nextId, expected, entries, pack, resolve, reject });
    dispatch();
  });
