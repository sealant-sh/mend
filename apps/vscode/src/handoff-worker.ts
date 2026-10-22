import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";

import { HandoffCutAt } from "@mend/domain/workbench";
import type {
  CaptureSummary,
  EnvFiles,
  LocalCheckout,
  Refused,
  Cancelled,
} from "@mend/local-git/handoff";
import { Option, Schema } from "effect";

import { WorkerReply, type WorkerJob, type WorkerResult } from "./handoff-protocol.js";

export interface HandoffBundle {
  readonly bytes: number;
  readonly open: () => Readable;
}
export type LocalResult<T> = { readonly kind: "ok"; readonly value: T } | Refused | Cancelled;
export interface CheckoutWorker {
  discover(signal?: AbortSignal): Promise<LocalResult<LocalCheckout>>;
  capture(
    defaultBranch: string | null,
    fileBytes: number,
    env: EnvFiles,
    signal: AbortSignal,
  ): Promise<LocalResult<CaptureSummary>>;
  pack(): Promise<LocalResult<HandoffBundle>>;
  dispose(): Promise<void>;
}
const PREFIX = "mend-vscode-handoff-";
const failed = (): Refused => ({
  _tag: "refused",
  why: { reason: "git", words: "The handoff worker stopped. Try again." },
  message: "The handoff worker stopped. Try again.",
});

export class HandoffWorker implements CheckoutWorker {
  readonly #worker: Worker;
  readonly #scratch: string;
  readonly #pending = new Map<
    number,
    { resolve: (value: WorkerResult) => void; cancel: Int32Array }
  >();
  readonly #exited: Promise<void>;
  #sequence = 0;
  #closed = false;
  #disposing: Promise<void> | null = null;

  constructor(options: {
    readonly entry: string;
    readonly checkout: string;
    readonly git: string;
    readonly scratchParent?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly deadlineMs?: number;
  }) {
    this.#scratch = path.join(
      options.scratchParent ?? os.tmpdir(),
      `${PREFIX}${process.pid}-${randomUUID()}`,
    );
    this.#worker = new Worker(options.entry, {
      workerData: {
        checkout: options.checkout,
        scratch: this.#scratch,
        git: options.git,
        timeoutMs: options.timeoutMs ?? 30_000,
        deadlineMs: options.deadlineMs ?? 120_000,
      },
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const read = Schema.decodeUnknownOption(WorkerReply);
    this.#worker.on("message", (value: unknown) => {
      const reply = read(value);
      if (Option.isNone(reply)) {
        void this.dispose();
        return;
      }
      const waiting = this.#pending.get(reply.value.id);
      if (waiting === undefined) {
        void this.dispose();
        return;
      }
      this.#pending.delete(reply.value.id);
      waiting.resolve(reply.value.result);
    });
    this.#worker.on("messageerror", () => void this.dispose());
    this.#worker.on("error", () => {
      this.#closed = true;
    });
    this.#exited = new Promise((resolve) => {
      this.#worker.once("exit", () => {
        this.#closed = true;
        for (const waiting of this.#pending.values()) waiting.resolve(failed());
        this.#pending.clear();
        void fs.rm(this.#scratch, { recursive: true, force: true }).then(resolve, resolve);
      });
    });
  }

  #ask(job: WorkerJob, signal?: AbortSignal): Promise<WorkerResult> {
    if (this.#closed) return Promise.resolve(failed());
    const id = ++this.#sequence;
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const cancel = () => Atomics.store(flag, 0, 1);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true) cancel();
    return new Promise<WorkerResult>((resolve) => {
      this.#pending.set(id, { resolve, cancel: flag });
      this.#worker.postMessage({ id, job, cancel: flag.buffer }, []);
    }).finally(() => signal?.removeEventListener("abort", cancel));
  }

  async discover(signal?: AbortSignal): Promise<LocalResult<LocalCheckout>> {
    const result = await this.#ask({ kind: "discover" }, signal);
    if (result._tag === "checkout") return { kind: "ok", value: result.checkout };
    return result._tag === "refused" || result._tag === "cancelled" ? result : failed();
  }

  async capture(
    defaultBranch: string | null,
    fileBytes: number,
    envFiles: EnvFiles,
    signal: AbortSignal,
  ): Promise<LocalResult<CaptureSummary>> {
    const result = await this.#ask(
      {
        kind: "capture",
        defaultBranch,
        fileBytes,
        envFiles,
        cutAt: HandoffCutAt.make(new Date().toISOString()),
      },
      signal,
    );
    if (result._tag === "captured") return { kind: "ok", value: result.summary };
    return result._tag === "refused" || result._tag === "cancelled" ? result : failed();
  }

  async pack(): Promise<LocalResult<HandoffBundle>> {
    const result = await this.#ask({ kind: "pack" });
    if (result._tag !== "packed")
      return result._tag === "refused" || result._tag === "cancelled" ? result : failed();
    const real = await fs.realpath(result.bundlePath).catch(() => "");
    const root = await fs.realpath(this.#scratch).catch(() => "");
    if (root === "" || !real.startsWith(`${root}${path.sep}`)) {
      await this.dispose();
      return failed();
    }
    return { kind: "ok", value: { bytes: result.bundleBytes, open: () => createReadStream(real) } };
  }

  dispose(): Promise<void> {
    if (this.#disposing !== null) return this.#disposing;
    for (const waiting of this.#pending.values()) Atomics.store(waiting.cancel, 0, 1);
    this.#disposing = (async () => {
      if (!this.#closed) await this.#ask({ kind: "dispose" });
      await this.#exited;
    })();
    return this.#disposing;
  }
}

export const sweepHandoffScratch = async (parent = os.tmpdir()): Promise<void> => {
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const pid = new RegExp(`^${PREFIX}(\\d+)-[0-9a-f-]{36}$`).exec(entry.name)?.[1];
    if (pid === undefined || !entry.isDirectory()) continue;
    try {
      process.kill(Number(pid), 0);
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && Reflect.get(cause, "code") === "ESRCH")
        await fs.rm(path.join(parent, entry.name), { recursive: true, force: true });
    }
  }
};
