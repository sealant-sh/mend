import { ScreenRtcUnavailable } from "@mend/api-contracts";
import type { ForwardBytes } from "@mend/sealant";
import { Cause, Deferred, Effect, Fiber, type Scope } from "effect";

import { ScreenH264 } from "./screen-h264.ts";

type Frame = NonNullable<ReturnType<ScreenH264["push"]>>[number];

/** Two encoder listeners feed one continuous RTP timeline, switching only at a complete IDR. */
export const streamScreenVideo = (options: {
  readonly pointer: Effect.Effect<boolean>;
  readonly open: (
    pointer: boolean,
  ) => Effect.Effect<Pick<ForwardBytes, "read">, ScreenRtcUnavailable, Scope.Scope>;
  readonly emit: (frame: Frame) => void;
}): Effect.Effect<void, ScreenRtcUnavailable> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ended = yield* Deferred.make<never, ScreenRtcUnavailable>();
      let sequence = 0;
      let timestamp = 0;
      let ssrc: number | undefined;

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
                      if (!frame.idr) continue;
                      yield* Deferred.succeed(ready, undefined);
                      yield* Deferred.await(activate);
                      waiting = false;
                    }
                    if (!source.active) continue;
                    // Each parser starts its own RTP counters. Only selected frames spend
                    // the shared counters, so discarded candidate frames leave no gaps.
                    ssrc ??= frame.packets[0]?.header.ssrc;
                    for (const packet of frame.packets) {
                      packet.header.sequenceNumber = sequence;
                      sequence = (sequence + 1) & 0xffff;
                      packet.header.timestamp = timestamp;
                      packet.header.ssrc = ssrc ?? 0;
                    }
                    timestamp = (timestamp + 3000) >>> 0;
                    options.emit(frame);
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
