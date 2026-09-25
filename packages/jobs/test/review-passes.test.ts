import { ChangePassesRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { type JobSpec, JobRunner } from "../src/job-runner.ts";
import { queueReviewPass, reviewPassKey } from "../src/review-passes.ts";

const CHANGE = ChangeId.make("change-1");

const queueWith = (answer: string | null) => {
  const sent: Array<JobSpec> = [];
  const rows: Array<string> = [];
  const layer = Layer.mergeAll(
    Layer.mock(JobRunner, {
      enqueue: (job) => Effect.sync(() => (sent.push(job), answer)),
    }),
    Layer.mock(ChangePassesRepo, {
      queue: (_changeId, kind) => Effect.sync(() => void rows.push(`queued:${kind}`)),
    }),
  );
  return Effect.runPromise(queueReviewPass("tour", CHANGE).pipe(Effect.provide(layer))).then(
    (queued) => ({ queued, sent, rows }),
  );
};

describe("queueReviewPass", () => {
  it("uses one key per change and pass, whoever asks", () => {
    expect(reviewPassKey("tour", CHANGE)).toBe("compose-tour:change-1");
    expect(reviewPassKey("suggest", CHANGE)).toBe("suggest-change:change-1");
    expect(reviewPassKey("read", CHANGE)).toBe("read-change:change-1");
  });

  it("marks the pass queued, then enqueues its job", async () => {
    const { queued, sent, rows } = await queueWith("job-1");
    expect(queued).toBe(true);
    expect(rows).toEqual(["queued:tour"]);
    expect(sent).toEqual([
      {
        name: "compose-tour",
        payload: { changeId: CHANGE },
        idempotencyKey: "compose-tour:change-1",
      },
    ]);
  });

  it("answers false when a job for the pass is already live", async () => {
    const { queued, rows } = await queueWith(null);
    expect(queued).toBe(false);
    // The row write keeps a queued or running pass as it is (ChangePassesRepo.queue).
    expect(rows).toEqual(["queued:tour"]);
  });
});
