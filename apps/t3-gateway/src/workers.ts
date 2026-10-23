import type { Worker } from "node:worker_threads";

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Four workers left over 850 MiB of data headroom at a 256 MiB parent load with 64 MiB code ranges. */
export const GATEWAY_WORKER_LIMIT = 4;

const permits = Semaphore.makeUnsafe(GATEWAY_WORKER_LIMIT);

// Only waiting is interruptible: canceling a raw take after its increment would lose a permit.
const takePermit: Effect.Effect<void> = Effect.suspend(() =>
  permits
    .takeIfAvailable(1)
    .pipe(
      Effect.flatMap((taken) =>
        taken
          ? Effect.void
          : permits
              .withPermits(1)(Effect.void)
              .pipe(Effect.interruptible, Effect.andThen(takePermit)),
      ),
    ),
);

/** A live isolate owns its permit until stop finishes, including while pooled and idle. */
export interface GatewayWorker {
  readonly worker: Worker;
  readonly stop: Effect.Effect<void>;
}

/** Wait interruptibly for process-wide capacity, then acquire a worker with an idempotent stop. */
export const startGatewayWorker = (create: () => Worker): Effect.Effect<GatewayWorker> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      yield* takePermit;
      const worker = yield* Effect.sync(create).pipe(Effect.onError(() => permits.release(1)));
      const stop = yield* Effect.cached(
        Effect.promise(() => worker.terminate()).pipe(
          Effect.andThen(permits.release(1)),
          Effect.asVoid,
        ),
      );
      return { worker, stop: Effect.uninterruptible(stop) };
    }),
  );
