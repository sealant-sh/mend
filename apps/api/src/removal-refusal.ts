import { RemovalInProgress } from "@mend/api-contracts";
import {
  isRemovalFenced,
  isRemovalStopped,
  isRemovedProject,
  type RetainedProject,
} from "@mend/db";
import {
  PURGING_PROJECT_WORK_REFUSED,
  REMOVED_PROJECT_START_REFUSED,
  REMOVED_PROJECT_WORK_REFUSED,
  REMOVAL_START_REFUSED,
  REMOVAL_START_REFUSED_STOPPED,
} from "@mend/domain/workbench";
import { Cause, Data, Effect } from "effect";

/**
 * A request that would change a removed project, refused by `ProjectAccess` before it reads
 * anything more: the access check's twin of the database's fence, answered the same way.
 */
export class RemovedProjectWork extends Data.TaggedError("RemovedProjectWork")<{
  readonly state: RetainedProject["state"];
}> {}

const removedProjectWorkOf = (cause: Cause.Cause<unknown>): RemovedProjectWork | null => {
  for (const reason of cause.reasons)
    if (Cause.isDieReason(reason) && reason.defect instanceof RemovedProjectWork)
      return reason.defect;
  return null;
};

/**
 * New work a removal's mark refused (migration 0166's triggers, or `refuseStartWhileRemoving`),
 * as the person reads it; null for any other failure. The API's error boundary answers every
 * route with it, and `refusedWhileRemoving` types it for `SessionStart`, whose Slack caller has
 * no boundary.
 */
export const removalInProgressOf = (cause: Cause.Cause<unknown>): RemovalInProgress | null => {
  const work = removedProjectWorkOf(cause);
  if (work !== null)
    return new RemovalInProgress({
      message:
        work.state === "purging" ? PURGING_PROJECT_WORK_REFUSED : REMOVED_PROJECT_WORK_REFUSED,
    });
  return isRemovalFenced(cause)
    ? new RemovalInProgress({
        message: isRemovedProject(cause)
          ? REMOVED_PROJECT_START_REFUSED
          : isRemovalStopped(cause)
            ? REMOVAL_START_REFUSED_STOPPED
            : REMOVAL_START_REFUSED,
      })
    : null;
};

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
