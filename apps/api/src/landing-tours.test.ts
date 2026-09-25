import { ChangePassesRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import { JobEnqueueError, JobRunner, type JobSpec } from "@mend/jobs";
import { TourRequests } from "@mend/landing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { TourRequestsLive } from "./landing-tours.ts";

/** A landing with no tour asks for one (docs/adr/0007-landing.md), and never fails for it. */

const request = (fails: boolean) => {
  const enqueued: Array<JobSpec> = [];
  const passes: Array<string> = [];
  const layer = TourRequestsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(JobRunner, {
          enqueue: (job) =>
            Effect.suspend(() => {
              enqueued.push(job);
              return fails
                ? Effect.fail(new JobEnqueueError({ job: job.name, cause: new Error("boss down") }))
                : Effect.succeed("job-1");
            }),
        }),
        Layer.mock(ChangePassesRepo, {
          queue: (_changeId, kind) => Effect.sync(() => void passes.push(`queued:${kind}`)),
          fail: (_changeId, kind) => Effect.sync(() => void passes.push(`failed:${kind}`)),
        }),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* TourRequests).request({ changeId: ChangeId.make("change-1") });
      return { enqueued, passes };
    }).pipe(Effect.provide(layer)),
  );
};

describe("TourRequestsLive", () => {
  it("queues the compose-tour pass under the key review prep and the review page use", async () => {
    const { enqueued, passes } = await request(false);
    expect(enqueued).toEqual([
      {
        name: "compose-tour",
        payload: { changeId: "change-1" },
        idempotencyKey: "compose-tour:change-1",
      },
    ]);
    expect(passes).toEqual(["queued:tour"]);
  });

  it("never fails the landing when the queue refuses, and the pass says it was not queued", async () => {
    const { enqueued, passes } = await request(true);
    expect(enqueued).toHaveLength(1);
    expect(passes).toEqual(["queued:tour", "failed:tour"]);
  });
});
