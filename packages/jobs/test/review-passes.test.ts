import { ChangePassesRepo } from "@mend/db";
import { ChangeId } from "@mend/domain";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { type Enqueued, type JobSpec, JobRunner } from "../src/job-runner.ts";
import { queueReviewPass, reviewPassKey } from "../src/review-passes.ts";

const CHANGE = ChangeId.make("change-1");

const queueWith = (answer: Enqueued) => {
  const sent: Array<JobSpec> = [];
  const rows: Array<string> = [];
  const events: Array<string> = [];
  const layer = Layer.mergeAll(
    Layer.mock(JobRunner, {
      enqueue: (job) =>
        Effect.sync(() => {
          events.push("enqueue");
          sent.push(job);
          return answer;
        }),
    }),
    Layer.mock(ChangePassesRepo, {
      queue: (_changeId, kind) =>
        Effect.sync(() => {
          events.push(`queued:${kind}`);
          rows.push(`queued:${kind}`);
        }),
    }),
  );
  return Effect.runPromise(
    queueReviewPass("tour", CHANGE, "user-asker").pipe(Effect.provide(layer)),
  ).then((queued) => ({ queued, sent, rows, events }));
};

describe("queueReviewPass", () => {
  it("uses one key per change and pass, whoever asks", () => {
    expect(reviewPassKey("tour", CHANGE)).toBe("compose-tour:change-1");
    expect(reviewPassKey("suggest", CHANGE)).toBe("suggest-change:change-1");
    expect(reviewPassKey("read", CHANGE)).toBe("read-change:change-1");
  });

  it("marks the pass queued, then enqueues its job on the asker's login", async () => {
    const { queued, sent, rows, events } = await queueWith({ _tag: "Queued", id: "job-1" });
    expect(queued).toEqual({ _tag: "Queued", id: "job-1" });
    expect(events).toEqual(["queued:tour", "enqueue"]);
    expect(rows).toEqual(["queued:tour"]);
    expect(sent).toEqual([
      {
        name: "compose-tour",
        payload: { changeId: CHANGE, requestedBy: "user-asker" },
        idempotencyKey: "compose-tour:change-1",
      },
    ]);
  });

  it("answers which live job for the pass absorbed the request", async () => {
    const { queued, rows } = await queueWith({ _tag: "Absorbed", running: true });
    expect(queued).toEqual({ _tag: "Absorbed", running: true });
    // The row write keeps a queued or running pass as it is (ChangePassesRepo.queue).
    expect(rows).toEqual(["queued:tour"]);
  });
});
