import { it } from "@mend/test-ci/effect-vitest";
import { Context, Deferred, Effect, Exit, Fiber, Stream } from "effect";
import { describe, expect } from "vitest";

import {
  forkSealantBackground,
  sealantRequestPriority,
  withInteractiveSealant,
  withSealantRequestPriority,
} from "./request-priority.ts";

const check = (expected: "normal" | "interactive") =>
  Effect.gen(function* () {
    for (let i = 0; i < 64; i++) {
      yield* Effect.yieldNow;
      yield* Effect.promise(() => Promise.resolve());
      expect(sealantRequestPriority()).toBe(expected);
    }
  });

describe("Sealant workflow allowance", () => {
  it.effect(
    "delivers once after a normal-context wake and preserves concurrent background refusals",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const wake = yield* Deferred.make<void>();
        const received: Array<string> = [];
        // The facade's cached handle starts a separate Promise/Effect runtime on each use.
        const handle = {
          send: (message: string) =>
            Effect.runPromise(
              Effect.promise(async () => {
                await Promise.resolve();
                if (sealantRequestPriority() !== "interactive") throw new Error("normal exhausted");
                received.push(message);
              }),
            ),
        };
        const sending = yield* Effect.gen(function* () {
          yield* Deferred.succeed(ready, undefined);
          yield* Deferred.await(wake);
          yield* Effect.promise(() => handle.send("follow-up"));
        }).pipe(withInteractiveSealant, Effect.forkChild);
        yield* Deferred.await(ready);
        const refused = yield* Effect.tryPromise(() => handle.send("background")).pipe(Effect.exit);
        expect(Exit.isFailure(refused)).toBe(true);
        yield* Deferred.succeed(wake, undefined);
        yield* Fiber.join(sending);
        expect(received).toEqual(["follow-up"]);
        expect(sealantRequestPriority()).toBe("normal");
      }),
  );

  it.effect("interleaved scheduler yields keep each fiber's workflow priority", () =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      const interactive = yield* Effect.gen(function* () {
        yield* Deferred.succeed(waiting, undefined);
        yield* Deferred.await(resumed);
        yield* check("interactive");
      }).pipe(withInteractiveSealant, Effect.forkChild);
      yield* Deferred.await(waiting);
      const background = yield* Effect.gen(function* () {
        yield* Deferred.succeed(resumed, undefined);
        yield* check("normal");
      }).pipe(withSealantRequestPriority("normal"), Effect.forkChild);
      yield* Fiber.join(interactive);
      yield* Fiber.join(background);
    }),
  );

  it.effect("a stream started during a send stays normal through later polling and reconnect", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const reconnect = yield* Deferred.make<void>();
      const readings: Array<string> = [];
      const background = yield* Effect.gen(function* () {
        const stream = Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              readings.push(sealantRequestPriority());
              yield "opened";
              await Effect.runPromise(Deferred.await(reconnect));
              await Promise.resolve();
              readings.push(sealantRequestPriority());
              yield "reconnected";
            },
          },
          (cause) => cause,
        );
        const fiber = yield* stream.pipe(
          Stream.tap(() => Deferred.succeed(opened, undefined)),
          Stream.runCollect,
          forkSealantBackground(yield* Effect.scope, { startImmediately: true }),
        );
        yield* Deferred.await(opened);
        expect(sealantRequestPriority()).toBe("interactive");
        return fiber;
      }).pipe(withInteractiveSealant);
      yield* Deferred.succeed(reconnect, undefined);
      expect(yield* Fiber.join(background)).toEqual(["opened", "reconnected"]);
      expect(readings).toEqual(["normal", "normal"]);
    }),
  );

  it.effect("explicit maintenance remains normal when it calls a person-facing entrypoint", () =>
    Effect.gen(function* () {
      const reading = Effect.sync(sealantRequestPriority).pipe(withInteractiveSealant);
      expect(yield* reading).toBe("interactive");
      expect(yield* reading.pipe(withSealantRequestPriority("normal"))).toBe("normal");
    }),
  );

  it.effect("preserves services and joins cancellation finalizers before returning", () =>
    Effect.gen(function* () {
      const Value = Context.Service<string>("priority-test/value");
      const entered = yield* Deferred.make<void>();
      const finalizing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let finished = false;
      const working = yield* Effect.gen(function* () {
        expect(yield* Value).toBe("caller");
        yield* Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
          Deferred.succeed(finalizing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                finished = true;
              }),
            ),
          ),
        );
        yield* Effect.never;
      }).pipe(
        Effect.scoped,
        Effect.provideService(Value, "caller"),
        withInteractiveSealant,
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      const interrupting = yield* Fiber.interrupt(working).pipe(Effect.forkChild);
      yield* Deferred.await(finalizing);
      expect(finished).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      expect(finished).toBe(true);
    }),
  );
});
