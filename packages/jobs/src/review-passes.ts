import { ChangePassesRepo } from "@mend/db";
import type { ChangeId } from "@mend/domain";
import type { PassKind } from "@mend/domain/workbench";
import { Effect } from "effect";

import { JobRunner } from "./job-runner.ts";

/** The job that runs each machine pass over a change. */
export const REVIEW_PASS_JOBS = {
  tour: "compose-tour",
  read: "read-change",
  suggest: "suggest-change",
} as const satisfies Record<PassKind, string>;

/**
 * One key per change and pass, whoever asks: review prep at settle, the review page, a landing
 * that finds no tour. While that pass is queued or running, another request is dropped; the job
 * reads the change as it is when it runs, so the dropped request loses nothing. Once it is done,
 * the next request queues a new one.
 */
export const reviewPassKey = (kind: PassKind, changeId: ChangeId): string =>
  `${REVIEW_PASS_JOBS[kind]}:${changeId}`;

/**
 * Queue one machine pass over a change. The pass row reads `queued` first (unless the pass is
 * already queued or running), so the review page says so instead of spinning, and the worker's
 * `begin` replaces it. True when this call queued a job; false when one was already live.
 */
export const queueReviewPass = Effect.fn("queueReviewPass")(function* (
  kind: PassKind,
  changeId: ChangeId,
) {
  const jobs = yield* JobRunner;
  const passes = yield* ChangePassesRepo;
  yield* passes.queue(changeId, kind);
  const queued = yield* jobs
    .enqueue({
      name: REVIEW_PASS_JOBS[kind],
      payload: { changeId },
      idempotencyKey: reviewPassKey(kind, changeId),
    })
    .pipe(
      Effect.tapError((error) =>
        passes.fail(changeId, kind, `the pass could not be queued: ${String(error.cause)}`),
      ),
    );
  return queued !== null;
});
