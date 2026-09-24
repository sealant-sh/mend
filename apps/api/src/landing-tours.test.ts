import { ChangeId, Sha } from "@mend/domain";
import { JobEnqueueError, JobRunner, type JobSpec } from "@mend/jobs";
import { TourRequests } from "@mend/landing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { TourRequestsLive } from "./landing-tours.ts";

/** A landing with no tour asks for one (docs/adr/0007-landing.md), and never fails for it. */

const request = (fails: boolean) => {
  const enqueued: Array<JobSpec> = [];
  const layer = TourRequestsLive.pipe(
    Layer.provide(
      Layer.mock(JobRunner, {
        enqueue: (job) =>
          Effect.suspend(() => {
            enqueued.push(job);
            return fails
              ? Effect.fail(new JobEnqueueError({ job: job.name, cause: new Error("boss down") }))
              : Effect.succeed("job-1");
          }),
      }),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* TourRequests).request({
        changeId: ChangeId.make("change-1"),
        head: Sha.make("a".repeat(40)),
      });
      return enqueued;
    }).pipe(Effect.provide(layer)),
  );
};

describe("TourRequestsLive", () => {
  it("queues the compose-tour job under review prep's key for the same state", async () => {
    expect(await request(false)).toEqual([
      {
        name: "compose-tour",
        payload: { changeId: "change-1" },
        idempotencyKey: `compose-tour:change-1:${"a".repeat(40)}`,
      },
    ]);
  });

  it("never fails the landing when the queue refuses", async () => {
    expect(await request(true)).toHaveLength(1);
  });
});
