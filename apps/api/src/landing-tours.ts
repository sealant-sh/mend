import { JobRunner } from "@mend/jobs";
import { TourRequests } from "@mend/landing";
import { Cause, Effect, Layer } from "effect";

/**
 * A landing that finds no tour asks for one (docs/adr/0007-landing.md, "The pull request's
 * description"): the same `compose-tour` job review prep queues, under the same key, so a tour
 * already queued for this state of the change is not composed twice. The landing never waits on
 * it and never fails for it; the worker writes the tour into the pull request when it completes.
 */
export const TourRequestsLive: Layer.Layer<TourRequests, never, JobRunner> = Layer.effect(
  TourRequests,
  Effect.gen(function* () {
    const jobs = yield* JobRunner;
    return {
      request: ({ changeId, head }) =>
        jobs
          .enqueue({
            name: "compose-tour",
            payload: { changeId },
            idempotencyKey: `compose-tour:${changeId}:${head}`,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("landing: the tour could not be queued").pipe(
                Effect.annotateLogs({ changeId, cause: Cause.pretty(cause) }),
              ),
            ),
          ),
    };
  }),
);
