import { assert, describe, it } from "@effect/vitest";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

import { makeFanout } from "../src/fanout.ts";

/**
 * Review round 1, finding 9: publication channels are bounded per subscriber, and a subscriber
 * buffers only what it accepts.
 */

describe("the hub's fanout", () => {
  it.effect("drops a subscriber that falls behind, with a typed failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fanout = makeFanout<number>(2);
        const slow = yield* fanout.subscribe(() => true);
        yield* fanout.publish([1, 2, 3]);
        assert.strictEqual(fanout.size(), 0);
        const exit = yield* Effect.exit(Stream.runCollect(slow));
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.include(String(exit.cause), "SubscriberFellBehind");
        }
      }),
    ),
  );

  it.effect("filters before buffering, so another thread's changes never fill a subscriber", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fanout = makeFanout<{ readonly thread: string; readonly n: number }>(2);
        const mine = yield* fanout.subscribe((item) => item.thread === "a");
        yield* fanout.publish([
          { thread: "b", n: 1 },
          { thread: "b", n: 2 },
          { thread: "b", n: 3 },
          { thread: "a", n: 4 },
        ]);
        assert.strictEqual(fanout.size(), 1);
        const read = yield* mine.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(Chunk.toReadonlyArray(Chunk.fromIterable(read)), [
          { thread: "a", n: 4 },
        ]);
      }),
    ),
  );

  it.effect("lets go of a subscriber when its scope closes", () =>
    Effect.gen(function* () {
      const fanout = makeFanout<number>();
      yield* Effect.scoped(fanout.subscribe(() => true));
      assert.strictEqual(fanout.size(), 0);
    }),
  );
});
