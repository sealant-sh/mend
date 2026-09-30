import { ChangePassesRepo } from "@mend/db";
import type { ChangeId } from "@mend/domain";
import type { PassKind } from "@mend/domain/workbench";
import type { InferenceError } from "@mend/inference";
import { asSealantUser } from "@mend/sealant";
import { Effect } from "effect";

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
 * own words — so the review page can state what ran instead of leaving "drafted nothing" and
 * "never ran" looking identical. Failures still propagate into pg-boss retry.
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
    yield* passes.begin(job.changeId, kind).pipe(
      Effect.andThen(pass),
      Effect.tap((findings) =>
        passes.complete(job.changeId, kind, typeof findings === "number" ? findings : null),
      ),
      Effect.tapError((error) => passes.fail(job.changeId, kind, error.message)),
      asSealantUser(job.requestedBy),
    );
  });
