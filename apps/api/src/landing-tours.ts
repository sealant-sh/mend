import { ChangePassesRepo } from "@mend/db";
import { JobRunner, queueReviewPass } from "@mend/jobs";
import { TourRequests } from "@mend/landing";
import { Cause, Effect, Layer } from "effect";

/**
 * A landing that finds no tour asks for one (docs/adr/0007-landing.md, "The pull request's
 * description"): the same `compose-tour` pass review prep and the review page queue, under the
 * same key (`reviewPassKey`), so a tour already queued or composing for the change absorbs the
 * request, and one whose diff has not changed is not composed again. The landing never waits on
 * it and never fails for it; the worker writes the tour into the pull request when it completes.
 */
export const TourRequestsLive: Layer.Layer<TourRequests, never, JobRunner | ChangePassesRepo> =
  Layer.effect(
    TourRequests,
    Effect.gen(function* () {
      const context = yield* Effect.context<JobRunner | ChangePassesRepo>();
      return {
        request: ({ changeId }) =>
          queueReviewPass("tour", changeId).pipe(
            Effect.provide(context),
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
