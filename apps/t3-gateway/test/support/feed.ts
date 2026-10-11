import type * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

type Feed<A, E> = {
  readonly next: <B extends A>(
    accept: (item: A) => item is B,
    timeout?: Duration.Input,
  ) => Effect.Effect<B, E | Cause.Done | Cause.TimeoutError>;
  readonly quiet: (
    accept: (item: A) => boolean,
    window?: Duration.Input,
  ) => Effect.Effect<boolean, E | Cause.Done>;
};

/**
 * A subscription read item by item: the stream runs in the background of the test's scope, and
 * `next` waits for the first item a predicate accepts. Failure or completion reaches the reader;
 * neither counts as a quiet, healthy subscription.
 */
export const feed = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Effect.Effect<Feed<A, E>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<A, E | Cause.Done>();
    yield* stream.pipe(Stream.runIntoQueue(inbox), Effect.forkScoped);
    const next = <B extends A>(
      accept: (item: A) => item is B,
      timeout: Duration.Input = "5 seconds",
    ) =>
      Effect.gen(function* () {
        for (;;) {
          const item = yield* Queue.take(inbox);
          if (accept(item)) return item;
        }
      }).pipe(Effect.timeout(timeout));
    /** Nothing arrives that a predicate accepts within the window. */
    const quiet = (accept: (item: A) => boolean, window: Duration.Input = "400 millis") =>
      Effect.gen(function* () {
        for (;;) {
          const item = yield* Queue.take(inbox);
          if (accept(item)) return item;
        }
      }).pipe(Effect.timeoutOption(window), Effect.map(Option.isNone));
    return { next, quiet };
  });
