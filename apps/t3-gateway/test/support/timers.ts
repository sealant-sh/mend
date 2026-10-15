import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { TestClock } from "./effect-vitest.ts";

/** A sleep a fiber of the case took on the TestClock, and when it ends on that clock. */
interface Sleep {
  readonly millis: number;
  readonly endsAt: number;
}

/**
 * The gateway's timers in a TestClock case. The gateway runs on its real sockets, so a reply can
 * still be in flight when the case wants a window run out: the case moves the clock only once a
 * fiber is parked on a timer, and only to that timer's end.
 */
export class GatewayTimers extends Context.Service<
  GatewayTimers,
  {
    /**
     * Waits until a fiber sleeps `window` and has not been woken: the gateway took its reply and
     * waits on its timer. The wait is real time, about five seconds at most, and fails naming
     * `what`.
     */
    readonly parked: (window: Duration.Input, what: string) => Effect.Effect<void>;
    /**
     * Runs the parked `window` out: `before` runs one millisecond short of its end, while nothing
     * waiting on it has happened, then the clock reaches the end.
     */
    readonly runOut: <E = never, R = never>(
      window: Duration.Input,
      what: string,
      before?: Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E, R>;
    /**
     * Until `done` holds, moves the clock to the end of the earliest timer of at most `within`
     * that a fiber is parked on, one timer at a time, and otherwise waits in real time for the
     * gateway to park. Fails naming `what` after about five seconds of real time without `done`.
     */
    readonly drive: (
      within: Duration.Input,
      done: () => boolean,
      what: string,
    ) => Effect.Effect<void>;
  }
>()("@mend/t3-gateway/test/GatewayTimers") {}

/** How many real 2 ms looks a wait takes before it fails: about five seconds. */
const LOOKS = 2_500;

const millisOf = (input: Duration.Input): number =>
  Duration.toMillis(Duration.fromInputUnsafe(input));

const look = TestClock.withLive(Effect.sleep("2 millis"));

/**
 * A TestClock case with every sleep of its fibers in view, the gateway's included, and
 * `GatewayTimers` to run them out.
 */
export const withGatewayTimers = <A, E, R>(
  test: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, GatewayTimers>> =>
  Clock.clockWith((clock) => {
    const sleeps = new Set<Sleep>();
    const watched: Clock.Clock = {
      ...clock,
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) =>
        Effect.suspend(() => {
          const millis = millisOf(duration);
          const sleep = { millis, endsAt: clock.currentTimeMillisUnsafe() + millis };
          sleeps.add(sleep);
          return clock
            .sleep(duration)
            .pipe(Effect.ensuring(Effect.sync(() => sleeps.delete(sleep))));
        }),
    };
    const pending = (accept: (sleep: Sleep) => boolean): Sleep | undefined => {
      const now = clock.currentTimeMillisUnsafe();
      let earliest: Sleep | undefined;
      for (const sleep of sleeps) {
        if (
          sleep.endsAt > now &&
          accept(sleep) &&
          (earliest === undefined || sleep.endsAt < earliest.endsAt)
        ) {
          earliest = sleep;
        }
      }
      return earliest;
    };
    const parkedOn = (window: Duration.Input, what: string) =>
      Effect.gen(function* () {
        const millis = millisOf(window);
        for (let looks = 0; looks < LOOKS; looks++) {
          const sleep = pending((candidate) => candidate.millis === millis);
          if (sleep !== undefined) return sleep;
          yield* look;
        }
        return yield* Effect.die(new Error(`Nothing was parked on ${what} (${millis} ms).`));
      });
    const timers = GatewayTimers.of({
      parked: (window, what) => Effect.asVoid(parkedOn(window, what)),
      runOut: (window, what, before) =>
        Effect.gen(function* () {
          const sleep = yield* parkedOn(window, what);
          yield* TestClock.adjust(sleep.endsAt - clock.currentTimeMillisUnsafe() - 1);
          if (before !== undefined) yield* before;
          yield* TestClock.adjust(1);
        }),
      drive: (within, done, what) =>
        Effect.gen(function* () {
          const bound = millisOf(within);
          for (let looks = 0; looks < LOOKS; looks++) {
            if (done()) return;
            const next = pending((sleep) => sleep.millis <= bound);
            if (next === undefined) yield* look;
            else yield* TestClock.adjust(next.endsAt - clock.currentTimeMillisUnsafe());
          }
          return yield* Effect.die(new Error(`Timed out driving the clock to ${what}.`));
        }),
    });
    return test.pipe(
      Effect.provideService(GatewayTimers, timers),
      Effect.provideService(Clock.Clock, watched),
    );
  });
