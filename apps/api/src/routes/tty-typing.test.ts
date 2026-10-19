import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Effect } from "effect";

import { makeKeystrokeClear } from "./tty-typing.ts";

/** A `clear` that answers each call from `answers` and records when it was called. */
const recordedClear = (answers: ReadonlyArray<boolean>) => {
  const calls: Array<number> = [];
  const clear = Effect.gen(function* () {
    calls.push(yield* Clock.currentTimeMillis);
    return answers[calls.length - 1] ?? false;
  });
  return { calls, clear };
};

describe("makeKeystrokeClear", () => {
  it.effect("lets keys typed while nothing waits pass, and holds back only after a clear", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, clear } = recordedClear([false, true, true]);
        const typed = makeKeystrokeClear(clear, yield* Effect.scope);
        yield* typed;
        yield* TestClock.adjust(100);
        yield* typed;
        yield* TestClock.adjust(500);
        yield* typed;
        expect(calls).toEqual([0, 100]);
        yield* TestClock.adjust(1_500);
        expect(calls).toEqual([0, 100, 2_100]);
      }),
    ),
  );

  it.effect("lands an answer typed right after a clear at the window's end, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, clear } = recordedClear([true, true]);
        const typed = makeKeystrokeClear(clear, yield* Effect.scope);
        yield* typed;
        yield* TestClock.adjust(200);
        yield* typed;
        yield* TestClock.adjust(100);
        yield* typed;
        expect(calls).toEqual([0]);
        yield* TestClock.adjust(1_700);
        expect(calls).toEqual([0, 2_000]);
        yield* TestClock.adjust(5_000);
        expect(calls).toEqual([0, 2_000]);
      }),
    ),
  );
});
