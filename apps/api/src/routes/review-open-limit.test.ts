import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Deferred, Duration, Effect, Fiber } from "effect";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

// Review of mend#649 (Astra, 2026-10-10): the request limit wrapped only the checkpoint, so a
// review open queued on the change's lock (or past its checkpoint, in the diff) was never
// answered — still waiting at 91 s through the real route. The whole request is under the limit
// now, its lock waits included; a shortened limit stands in for the 90 s one.
describe("POST /changes/:id/reviews/open under its request limit", () => {
  it.effect("answers that it did not finish while another request holds the change's lock", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const clock = yield* Clock.clockWith(Effect.succeed);
      const api = yield* Effect.acquireRelease(
        Effect.promise(() =>
          createTenancyApi(
            {},
            {
              effectClock: clock,
              checkpointRequestLimit: Duration.seconds(1),
              implement: {
                slices: {
                  // Another request holds the lock: this one waits on it until released.
                  withChangeLock: () =>
                    Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(released)),
                      Effect.andThen(Effect.die("the lock was never meant to be taken")),
                    ),
                },
              },
            },
          ),
        ),
        (fixture) => Effect.promise(() => fixture.dispose()),
      );
      const started = yield* Clock.currentTimeMillis;
      const request = yield* Effect.promise(() =>
        api.request("alice", "POST", `/api/changes/${ids("shared-a").change}/reviews/open`, {
          idempotencyKey: "review-open-limit",
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(999);
      expect(request.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      const response = yield* Fiber.join(request);
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Deferred.succeed(released, undefined);
      expect(yield* Deferred.isDone(entered)).toBe(true);
      expect(elapsed).toBeLessThan(10_000);
      expect(response.status).toBe(422);
      const body: unknown = yield* Effect.promise(() => response.json());
      expect(JSON.stringify(body)).toContain(
        "Review did not open: the request did not finish in 1s.",
      );
    }),
  );
});
