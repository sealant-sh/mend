import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { feed } from "./support/feed.ts";

describe("subscription assertions", () => {
  it.effect("delivers buffered matching items before reporting completion", () =>
    Effect.gen(function* () {
      const events = yield* feed(Stream.make(1, 2, 3));
      assert.strictEqual(yield* events.next((n): n is 2 | 3 => n > 1), 2);
      assert.strictEqual(yield* events.next((_n): _n is 1 | 2 | 3 => true), 3);
      assert.isTrue(Cause.isDone(yield* Effect.flip(events.quiet(() => true))));
    }),
  );

  it.effect("propagates authorization failure to both next and quiet", () =>
    Effect.gen(function* () {
      const failure = { _tag: "EnvironmentAuthorizationError" };
      const events = yield* feed(Stream.fail(failure));
      assert.strictEqual(yield* Effect.flip(events.next((_item): _item is never => true)), failure);
      assert.strictEqual(yield* Effect.flip(events.quiet(() => true)), failure);
    }),
  );

  it.effect("does not turn a stream defect into evidence of silence", () =>
    Effect.gen(function* () {
      const defect = new Error("broken subscription");
      const events = yield* feed(Stream.die(defect));
      assert.deepStrictEqual(yield* Effect.exit(events.quiet(() => true)), Exit.die(defect));
    }),
  );

  it.effect("only reports quiet after the observation window on an open stream", () =>
    Effect.gen(function* () {
      const events = yield* feed(Stream.never);
      const observed = yield* events.quiet(() => true).pipe(Effect.forkScoped);
      yield* TestClock.adjust("400 millis");
      assert.isTrue(yield* Fiber.join(observed));
    }),
  );

  it.effect("reports a matching event as nonquiet", () =>
    Effect.gen(function* () {
      const events = yield* feed(Stream.make("irrelevant", "changed"));
      assert.isFalse(yield* events.quiet((item) => item === "changed"));
    }),
  );
});
