import { RemovalInProgress } from "@mend/api-contracts";
import { isRemovalFenced, isRemovalStopped, isRemovedProject } from "@mend/db";
import {
  REMOVED_PROJECT_START_REFUSED,
  REMOVAL_START_REFUSED,
  REMOVAL_START_REFUSED_STOPPED,
} from "@mend/domain/workbench";
import { type Cause, Effect } from "effect";

/**
 * New work a removal's mark refused (migration 0166's triggers, or `refuseStartWhileRemoving`),
 * as the person reads it; null for any other failure. The API's error boundary answers every
 * route with it, and `refusedWhileRemoving` types it for `SessionStart`, whose Slack caller has
 * no boundary.
 */
export const removalInProgressOf = (cause: Cause.Cause<unknown>): RemovalInProgress | null =>
  isRemovalFenced(cause)
    ? new RemovalInProgress({
        message: isRemovedProject(cause)
          ? REMOVED_PROJECT_START_REFUSED
          : isRemovalStopped(cause)
            ? REMOVAL_START_REFUSED_STOPPED
            : REMOVAL_START_REFUSED,
      })
    : null;

/** A start whose refusal by a removal's mark its caller reads as `RemovalInProgress`. */
export const refusedWhileRemoving = <A, E, R>(
  start: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RemovalInProgress, R> =>
  start.pipe(
    Effect.catchCause((cause): Effect.Effect<never, E | RemovalInProgress> => {
      const refusal = removalInProgressOf(cause);
      return refusal === null ? Effect.failCause(cause) : Effect.fail(refusal);
    }),
  );
