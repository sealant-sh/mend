import { ChangePassesRepo } from "@mend/db";
import type { ChangeId } from "@mend/domain";
import {
  REVIEW_PASS_TIMEOUT_DETAIL,
  REVIEW_PASS_TIMEOUT_MS,
  type PassKind,
} from "@mend/domain/workbench";
import { InferenceError } from "@mend/inference";
import { asSealantUser } from "@mend/sealant";
import { Cause, Effect, Exit, Option } from "effect";

/** What a review pass job carries: the change, and who asked (absent on a job queued before). */
export interface ReviewPassJob {
  readonly changeId: ChangeId;
  readonly requestedBy?: string | undefined;
}

export const UNKNOWN_ASKER =
  "the pass was queued before Mend recorded who asked for it · ask for it again";

/**
 * Run one review pass on the login of whoever asked for it (docs/adr/0008-one-refresher-for-
 * provider-logins.md, "Whose login pays"): one person's request never spends another person's
 * login. A job that does not say who asked runs on no one's; its pass says so.
 *
 * Every pass records its outcome — running, completed with a count, or failed with the error's
 * own words. The whole pass has a deadline; defects and interruption also record a plain failure.
 * Failures still propagate into pg-boss retry.
 */
export const runReviewPass = (
  kind: PassKind,
  job: ReviewPassJob,
  pass: Effect.Effect<unknown, InferenceError>,
): Effect.Effect<void, InferenceError, ChangePassesRepo> =>
  Effect.gen(function* () {
    const passes = yield* ChangePassesRepo;
    if (job.requestedBy === undefined) {
      return yield* passes.fail(job.changeId, kind, UNKNOWN_ASKER);
    }
    yield* Effect.uninterruptibleMask((restore) =>
      // Cover begin and completion too: a notification or result-write defect must still
      // attempt to settle the row. Only inference is interruptible.
      passes.begin(job.changeId, kind).pipe(
        Effect.flatMap((began) =>
          began
            ? restore(
                pass.pipe(
                  Effect.timeoutOrElse({
                    duration: REVIEW_PASS_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new InferenceError({
                          message: REVIEW_PASS_TIMEOUT_DETAIL,
                          cause: null,
                        }),
                      ),
                  }),
                ),
              ).pipe(
                Effect.flatMap((findings) =>
                  passes.complete(
                    job.changeId,
                    kind,
                    typeof findings === "number" ? findings : null,
                  ),
                ),
              )
            : Effect.void,
        ),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void;
          const error = Cause.findErrorOption(exit.cause);
          const detail = Option.isSome(error)
            ? error.value.message
            : Cause.hasInterruptsOnly(exit.cause)
              ? "The review pass was interrupted. Ask for it again."
              : "The review pass failed unexpectedly. Ask for it again.";
          return passes.fail(job.changeId, kind, detail);
        }),
      ),
    ).pipe(asSealantUser(job.requestedBy));
  });
