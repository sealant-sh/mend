import { ScreenRtcUnavailable } from "@mend/api-contracts";
import type { ForwardBytes } from "@mend/sealant";
import { Cause, Clock, Deferred, Effect, Fiber, type Scope } from "effect";

import { ScreenH264 } from "./screen-h264.ts";

/** Arrival time is sampled once when a complete access unit is observed. */
export interface ScreenVideoFrame {
  readonly data: Uint8Array;
  readonly keyframe: boolean;
  readonly receivedAt: number;
}

/** Two encoder listeners feed one access-unit stream, switching only at a complete IDR. */
export const streamScreenVideo = (options: {
  readonly pointer: Effect.Effect<boolean, ScreenRtcUnavailable>;
  readonly open: (
    pointer: boolean,
  ) => Effect.Effect<Pick<ForwardBytes, "read">, ScreenRtcUnavailable, Scope.Scope>;
  readonly emit: (frame: ScreenVideoFrame) => void;
}): Effect.Effect<void, ScreenRtcUnavailable> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ended = yield* Deferred.make<never, ScreenRtcUnavailable>();

      const start = (pointer: boolean) =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void, ScreenRtcUnavailable>();
          const activate = yield* Deferred.make<void>();
          const source = { pointer, active: false };
          const fiber = yield* Effect.forkScoped(
            Effect.scoped(
              Effect.gen(function* () {
                const bytes = yield* options.open(pointer);
                const parser = new ScreenH264();
                let waiting = true;
                for (;;) {
                  const read = yield* bytes.read().pipe(
                    Effect.timeout("5 seconds"),
                    Effect.mapError(() => new ScreenRtcUnavailable()),
                  );
                  if (read.kind === "eof") return yield* new ScreenRtcUnavailable();
                  const frames = parser.push(read.bytes);
                  if (frames === null) return yield* new ScreenRtcUnavailable();
                  for (const frame of frames) {
                    if (waiting) {
                      if (!frame.keyframe) continue;
                      yield* Deferred.succeed(ready, undefined);
                      yield* Deferred.await(activate);
                      waiting = false;
                    }
                    if (!source.active) continue;
                    options.emit({ ...frame, receivedAt: yield* Clock.currentTimeMillis });
                  }
                }
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.gen(function* () {
                      yield* Deferred.fail(ready, new ScreenRtcUnavailable());
                      if (source.active) yield* Deferred.fail(ended, new ScreenRtcUnavailable());
                      else yield* Effect.logWarning("screen RTC: replacement encoder unavailable");
                    }),
              ),
            ),
          );
          return { source, fiber, ready, activate };
        });

      let current: Effect.Success<ReturnType<typeof start>> | undefined;
      const follow = Effect.forever(
        Effect.gen(function* () {
          const pointer = yield* options.pointer;
          if (current?.source.pointer !== pointer) {
            const next = yield* start(pointer);
            const ready = yield* Deferred.await(next.ready).pipe(Effect.result);
            if (ready._tag === "Failure") {
              if (current === undefined) return yield* ready.failure;
            } else if ((yield* options.pointer) === pointer) {
              const old = current;
              if (old !== undefined) old.source.active = false;
              next.source.active = true;
              current = next;
              yield* Deferred.succeed(next.activate, undefined);
              if (old !== undefined) yield* Fiber.interrupt(old.fiber);
            } else yield* Fiber.interrupt(next.fiber);
          }
          yield* Effect.sleep("100 millis");
        }),
      );
      yield* Effect.raceFirst(follow, Deferred.await(ended));
    }),
  );
