import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * A subscription read item by item: the stream runs in the background of the test's scope, and
 * `next` waits for the first item a predicate accepts, dropping the ones before it.
 */
export const feed = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<A>();
    yield* stream.pipe(
      Stream.runForEach((item) => Queue.offer(inbox, item)),
      Effect.ignore,
      Effect.forkScoped,
    );
    const next = <B extends A>(
      accept: (item: A) => item is B,
      timeout: number | `${number} seconds` = "5 seconds",
    ) =>
      Effect.gen(function* () {
        for (;;) {
          const item = yield* Queue.take(inbox);
          if (accept(item)) return item;
        }
      }).pipe(Effect.timeout(timeout));
    /** Nothing arrives that a predicate accepts within the window. */
    const quiet = (accept: (item: A) => boolean, window = "400 millis" as const) =>
      Effect.gen(function* () {
        for (;;) {
          const item = yield* Queue.take(inbox);
          if (accept(item)) return item;
        }
      }).pipe(Effect.timeoutOption(window), Effect.map(Option.isNone));
    return { next, quiet };
  });
