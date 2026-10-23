import { extname } from "node:path";
import { Worker } from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import type { ParseRequest } from "./find-parse.ts";
import { startGatewayWorker, type GatewayWorker } from "./workers.ts";

export class FindParser extends Context.Service<
  FindParser,
  {
    readonly segments: (request: ParseRequest) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@mend/t3-gateway/FindParser") {}

/**
 * In code units, t3code's own bound between its small and large text caches (`t3:apps/server/src/
 * orchestration-v2/ThreadFind.ts`). A parse's heap grows far faster than its text (nested quotes
 * need 192 MiB at 64 KiB), and a worker out of heap can abort the whole process, so every message
 * within the bound parses in half the worker's heap.
 */
export const PARSED_TEXT_LIMIT = 32 * 1024;

export interface FindParserPool {
  readonly workers: number;
  readonly heapMiB: number;
  readonly idleMs: number;
}

export const DEFAULT_FIND_PARSER_POOL: FindParserPool = {
  workers: 1,
  heapMiB: 256,
  idleMs: 60_000,
};

// Beside this module: `src/find-parse-worker.ts` from source, `dist/find-parse-worker.js` once
// bundled, since every bundled module's `import.meta.url` is `dist/bin.js`.
const WORKER_ENTRY = new URL(
  `./find-parse-worker${extname(new URL(import.meta.url).pathname)}`,
  import.meta.url,
);

const asWritten = ({ text }: ParseRequest): ReadonlyArray<string> => [text];

interface PooledWorker extends GatewayWorker {
  idle: ReturnType<typeof setTimeout> | undefined;
}

export const findParserLayer = (
  pool: FindParserPool = DEFAULT_FIND_PARSER_POOL,
): Layer.Layer<FindParser> =>
  Layer.effect(
    FindParser,
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(pool.workers);
      const idle: Array<PooledWorker> = [];
      const running = new Set<PooledWorker>();
      const discard = (pooled: PooledWorker): Effect.Effect<void> =>
        Effect.sync(() => {
          clearTimeout(pooled.idle);
          const at = idle.indexOf(pooled);
          if (at !== -1) idle.splice(at, 1);
        }).pipe(
          Effect.andThen(pooled.stop),
          Effect.andThen(Effect.sync(() => running.delete(pooled))),
          Effect.asVoid,
        );
      yield* Effect.addFinalizer(() =>
        Effect.forEach(running, discard, { concurrency: "unbounded", discard: true }),
      );
      const take = Effect.suspend((): Effect.Effect<PooledWorker> => {
        const available = idle.pop();
        if (available !== undefined) {
          clearTimeout(available.idle);
          return Effect.succeed(available);
        }
        return startGatewayWorker(
          () =>
            new Worker(WORKER_ENTRY, {
              resourceLimits: { maxOldGenerationSizeMb: pool.heapMiB, codeRangeSizeMb: 64 },
            }),
        ).pipe(
          Effect.map((lease) => {
            lease.worker.unref();
            const pooled: PooledWorker = { ...lease, idle: undefined };
            running.add(pooled);
            return pooled;
          }),
        );
      });
      const putBack = (pooled: PooledWorker) => {
        pooled.idle = setTimeout(() => {
          Effect.runFork(discard(pooled));
        }, pool.idleMs);
        pooled.idle.unref();
        idle.push(pooled);
      };

      const parse = (request: ParseRequest) =>
        Effect.acquireUseRelease(
          take,
          (pooled) =>
            Effect.callback<ReadonlyArray<string>, unknown>((resume) => {
              const settle = () => {
                pooled.worker.off("message", parsed);
                pooled.worker.off("error", failed);
                pooled.worker.off("exit", exited);
              };
              const parsed = (segments: ReadonlyArray<string>) => {
                settle();
                resume(Effect.succeed(segments));
              };
              const failed = (cause: unknown) => {
                settle();
                resume(Effect.fail(cause));
              };
              const exited = (code: number) =>
                failed(new Error(`find's parse worker exited (${code})`));
              pooled.worker.on("message", parsed);
              pooled.worker.on("error", failed);
              pooled.worker.on("exit", exited);
              try {
                // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, which has no origin.
                pooled.worker.postMessage(request);
              } catch (cause) {
                failed(cause);
              }
              return Effect.sync(settle);
            }),
          (pooled, exit) =>
            Exit.isSuccess(exit) ? Effect.sync(() => putBack(pooled)) : discard(pooled),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("find read a message as written: its parse failed", { cause }).pipe(
              Effect.as(asWritten(request)),
            ),
          ),
        );

      return {
        segments: (request) =>
          request.text.length > PARSED_TEXT_LIMIT
            ? Effect.succeed(asWritten(request))
            : permits.withPermits(1)(parse(request)),
      };
    }),
  );
