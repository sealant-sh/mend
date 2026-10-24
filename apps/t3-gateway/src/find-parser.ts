import { extname } from "node:path";
import { Worker } from "node:worker_threads";

import * as Cause from "effect/Cause";
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

type Answer = (exit: Exit.Exit<ReadonlyArray<string>, unknown>) => void;

/** Idle in the pool, taken by a parse, waiting for that parse's answer, or gone for good. */
type PooledState =
  | { readonly _tag: "idle"; readonly timer: ReturnType<typeof setTimeout> }
  | { readonly _tag: "taken" }
  | { readonly _tag: "waiting"; readonly answer: Answer }
  | { readonly _tag: "gone" };

interface PooledWorker extends GatewayWorker {
  state: PooledState;
}

const taken: PooledState = { _tag: "taken" };
const gone: PooledState = { _tag: "gone" };

export const findParserLayer = (
  pool: FindParserPool = DEFAULT_FIND_PARSER_POOL,
): Layer.Layer<FindParser> =>
  Layer.effect(
    FindParser,
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(pool.workers);
      const idle: Array<PooledWorker> = [];
      const running = new Set<PooledWorker>();
      /** The only way to `gone`: it leaves the pool, fails a waiting parse, and stops once. */
      const retire = (pooled: PooledWorker, cause: unknown): Effect.Effect<void> =>
        Effect.suspend(() => {
          const was = pooled.state;
          pooled.state = gone;
          if (was._tag === "idle") {
            clearTimeout(was.timer);
            const at = idle.indexOf(pooled);
            if (at !== -1) idle.splice(at, 1);
          } else if (was._tag === "waiting") {
            was.answer(Exit.fail(cause));
          }
          return pooled.stop.pipe(Effect.andThen(Effect.sync(() => running.delete(pooled))));
        });
      const answer = (pooled: PooledWorker, exit: Exit.Exit<ReadonlyArray<string>, unknown>) => {
        const state = pooled.state;
        if (state._tag !== "waiting") return;
        pooled.state = taken;
        state.answer(exit);
      };
      yield* Effect.addFinalizer(() =>
        Effect.forEach(running, (pooled) => retire(pooled, new Error("find closed")), {
          concurrency: "unbounded",
          discard: true,
        }),
      );
      const start = Effect.suspend((): Effect.Effect<PooledWorker> => {
        // Node emits a worker's events from its event loop, so listeners attached beside the
        // constructor miss none. An exit before the lease is handed out is kept until it is.
        let pooled: PooledWorker | undefined;
        let endedEarly: { readonly cause: unknown } | undefined;
        const ended = (cause: unknown) => {
          if (pooled === undefined) endedEarly ??= { cause };
          else Effect.runFork(retire(pooled, cause));
        };
        return startGatewayWorker(() => {
          const worker = new Worker(WORKER_ENTRY, {
            resourceLimits: { maxOldGenerationSizeMb: pool.heapMiB, codeRangeSizeMb: 64 },
          });
          worker.unref();
          worker.on("message", (segments: ReadonlyArray<string>) => {
            if (pooled !== undefined) answer(pooled, Exit.succeed(segments));
          });
          worker.on("error", ended);
          worker.on("exit", (code) => ended(new Error(`find's parse worker exited (${code})`)));
          return worker;
        }).pipe(
          Effect.flatMap((lease) => {
            const leased: PooledWorker = { ...lease, state: taken };
            pooled = leased;
            running.add(leased);
            return endedEarly === undefined
              ? Effect.succeed(leased)
              : retire(leased, endedEarly.cause).pipe(Effect.as(leased));
          }),
        );
      });
      const take = Effect.suspend((): Effect.Effect<PooledWorker> => {
        const available = idle.pop();
        if (available?.state._tag !== "idle") return start;
        clearTimeout(available.state.timer);
        available.state = taken;
        return Effect.succeed(available);
      });
      const putBack = (pooled: PooledWorker) =>
        Effect.sync(() => {
          if (pooled.state._tag !== "taken") return;
          const timer = setTimeout(() => {
            Effect.runFork(retire(pooled, new Error("find's parse worker idled out")));
          }, pool.idleMs);
          timer.unref();
          pooled.state = { _tag: "idle", timer };
          idle.push(pooled);
        });

      const parse = (request: ParseRequest) =>
        Effect.acquireUseRelease(
          take,
          (pooled) =>
            Effect.callback<ReadonlyArray<string>, unknown>((resume) => {
              if (pooled.state._tag !== "taken") {
                resume(Effect.fail(new Error("find's parse worker exited")));
                return;
              }
              pooled.state = { _tag: "waiting", answer: resume };
              try {
                // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, which has no origin.
                pooled.worker.postMessage(request);
              } catch (cause) {
                answer(pooled, Exit.fail(cause));
              }
              return Effect.sync(() => {
                if (pooled.state._tag === "waiting") pooled.state = taken;
              });
            }),
          (pooled, exit) =>
            Exit.isSuccess(exit) ? putBack(pooled) : retire(pooled, Cause.squash(exit.cause)),
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
