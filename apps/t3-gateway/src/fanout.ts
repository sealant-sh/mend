import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * One publication channel of the projection hub, with a bounded buffer per subscriber. A
 * subscriber takes only what it accepts (one thread's changes, say), filtered before anything is
 * buffered, so a slow reader never holds what it would not read. A subscriber that falls more than
 * `capacity` items behind is dropped: its stream fails with `SubscriberFellBehind`, which the RPC
 * layer answers as the method's typed failure, and t3code resubscribes and gets a fresh snapshot.
 */

export class SubscriberFellBehind extends Schema.TaggedError<SubscriberFellBehind>()(
  "SubscriberFellBehind",
  { capacity: Schema.Number },
) {
  override get message(): string {
    return `The subscriber fell more than ${this.capacity} changes behind; subscribe again.`;
  }
}

/** How many changes one subscriber may have unread before it is dropped. */
export const SUBSCRIBER_CAPACITY = 2_048;

export interface Fanout<A> {
  /** A stream of what `accept` takes from here on, for as long as the scope lasts. */
  readonly subscribe: (
    accept: (item: A) => boolean,
  ) => Effect.Effect<Stream.Stream<A, SubscriberFellBehind>, never, Scope.Scope>;
  /** Hands each item to every subscriber that accepts it. */
  readonly publish: (items: ReadonlyArray<A>) => Effect.Effect<void>;
  /** How many subscribers are attached, for tests. */
  readonly size: () => number;
}

interface Subscriber<A> {
  readonly queue: Queue.Queue<A, SubscriberFellBehind>;
  readonly accept: (item: A) => boolean;
}

export const makeFanout = <A>(capacity: number = SUBSCRIBER_CAPACITY): Fanout<A> => {
  const subscribers = new Set<Subscriber<A>>();

  const subscribe = (accept: (item: A) => boolean) =>
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<A, SubscriberFellBehind>(capacity);
      const subscriber: Subscriber<A> = { queue, accept };
      yield* Effect.acquireRelease(
        Effect.sync(() => subscribers.add(subscriber)),
        () =>
          Effect.sync(() => {
            subscribers.delete(subscriber);
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
      );
      return Stream.fromQueue(queue);
    });

  const publish = (items: ReadonlyArray<A>) =>
    Effect.sync(() => {
      for (const subscriber of subscribers) {
        for (const item of items) {
          if (!subscriber.accept(item)) continue;
          if (Queue.offerUnsafe(subscriber.queue, item)) continue;
          subscribers.delete(subscriber);
          Queue.failCauseUnsafe(
            subscriber.queue,
            Cause.fail(new SubscriberFellBehind({ capacity })),
          );
          break;
        }
      }
    });

  return { subscribe, publish, size: () => subscribers.size };
};
