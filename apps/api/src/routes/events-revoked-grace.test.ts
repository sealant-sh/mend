import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Deferred, Duration, Effect } from "effect";
import { describe, expect } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { type HarnessUser, ids } from "../../test/support/tenancy-harness.ts";

/**
 * The revoked stream's grace (RC 0.36.0-next.754, B-F1) counts from the revocation, however long
 * the stream has been open. Removal closes the account's streams on the same bus event its page
 * must hear; the close may win, and the page must still learn why before the stream ends.
 */
const sharedA = ids("shared-a");
const access = { type: "user", userId: "carol", facet: "access" } as const;
const OPEN_FOR = "10 seconds";
const SILENCE_MS = 150;

const eventually = async (what: string, holds: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`never observed: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A world whose event route runs on this test's TestClock, and a signal for the first
 * grace-length sleep the route asks for once `revoke` has been called.
 */
const graceWorld = Effect.gen(function* () {
  const clock = yield* Clock.clockWith(Effect.succeed);
  const graceSleeping = yield* Deferred.make<void>();
  let revoked = false;
  const observedClock: Clock.Clock = {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanos: clock.currentTimeNanos,
    sleep: (duration) =>
      revoked && Duration.toMillis(duration) === 1_000
        ? Deferred.succeed(graceSleeping, undefined).pipe(Effect.andThen(clock.sleep(duration)))
        : clock.sleep(duration),
  };
  const world = yield* Effect.acquireRelease(
    Effect.promise(() => createTenancyApi({}, { effectClock: observedClock })),
    (fixture) => Effect.promise(() => fixture.dispose()),
  );
  const revoke = (user: HarnessUser) =>
    Effect.promise(() => {
      revoked = true;
      return world.closeConnectionsOf(user);
    });
  // Bounded on the live clock: a stream that never waits for its access event fails here.
  const graceStarted = TestClock.withLive(
    Deferred.await(graceSleeping).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the revoked stream never waited for its access event")),
      }),
    ),
  );
  return { world, revoke, graceStarted };
});

const open = (world: TenancyApi, user: "alice" | "carol") =>
  Effect.promise(() => world.events(user));

describe("a revoked event stream's grace", () => {
  it.effect("still hears why it ended when the close comes first, however long it was open", () =>
    Effect.gen(function* () {
      const { world, revoke } = yield* graceWorld;
      const carol = yield* open(world, "carol");
      const alice = yield* open(world, "alice");
      yield* TestClock.adjust(OPEN_FOR);

      expect(yield* revoke("carol")).toBe(1);
      yield* Effect.promise(() => world.notify(access));
      expect(yield* Effect.promise(() => carol.next(1_000))).toBe(
        `data: ${JSON.stringify(access)}`,
      );
      // Then the stream ends.
      expect(yield* Effect.promise(() => carol.next(SILENCE_MS))).toBeNull();
      yield* Effect.promise(() =>
        eventually(
          "carol's stream released",
          async () => (await world.openConnections("carol", "event-stream")) === 0,
        ),
      );
      yield* Effect.promise(() => carol.close());
      yield* Effect.promise(() => alice.close());
    }),
  );

  it.effect("ends a stream that never hears why exactly one grace after the revocation", () =>
    Effect.gen(function* () {
      const { world, revoke, graceStarted } = yield* graceWorld;
      const carol = yield* open(world, "carol");
      const alice = yield* open(world, "alice");
      yield* TestClock.adjust(OPEN_FOR);

      expect(yield* revoke("carol")).toBe(1);
      yield* graceStarted;
      yield* TestClock.adjust(999);
      expect(yield* Effect.promise(() => world.openConnections("carol", "event-stream"))).toBe(1);
      yield* TestClock.adjust(1);
      yield* Effect.promise(() =>
        eventually(
          "carol's stream released",
          async () => (await world.openConnections("carol", "event-stream")) === 0,
        ),
      );
      expect(yield* Effect.promise(() => carol.next(SILENCE_MS))).toBeNull();

      // Another account's stream goes on.
      const event = {
        type: "session",
        sessionId: sharedA.session,
        projectId: sharedA.project,
      } as const;
      yield* Effect.promise(() => world.notify(event));
      expect(yield* Effect.promise(() => alice.next(1_000))).toBe(`data: ${JSON.stringify(event)}`);
      yield* Effect.promise(() => carol.close());
      yield* Effect.promise(() => alice.close());
    }),
  );
});
