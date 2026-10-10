import { Deferred, Duration, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

// Review of mend#649 (Astra, 2026-10-10): the request limit wrapped only the checkpoint, so a
// review open queued on the change's lock (or past its checkpoint, in the diff) was never
// answered — still waiting at 91 s through the real route. The whole request is under the limit
// now, its lock waits included; a shortened limit stands in for the 90 s one.
describe("POST /changes/:id/reviews/open under its request limit", () => {
  let api: TenancyApi | null = null;
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  it("answers that it did not finish while another request holds the change's lock", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const released = Deferred.makeUnsafe<void>();
    api = await createTenancyApi(
      {},
      {
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
    );
    const started = Date.now();
    const response = await api.request(
      "alice",
      "POST",
      `/api/changes/${ids("shared-a").change}/reviews/open`,
      { idempotencyKey: "review-open-limit" },
    );
    const elapsed = Date.now() - started;
    await Effect.runPromise(Deferred.succeed(released, undefined));
    expect(Effect.runSync(Deferred.isDone(entered))).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
    expect(response.status).toBe(422);
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).toContain(
      "Review did not open: the request did not finish in 1s.",
    );
  });
});
