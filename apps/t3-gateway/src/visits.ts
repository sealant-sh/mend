/**
 * Read state (`thread.visit`, `thread.mark-unread`): when the person last saw a thread, kept by the
 * gateway per person as Mend has no read state (ADR 0012), with the rules t3code's own server
 * applies (`dispatchThreadVisit` and `thread.mark-unread` in `Orchestrator.ts` at the pinned tag).
 *
 * The shell carries it as `lastVisitedAt`, and t3code's client reads the unread marker from it:
 * a thread whose latest run completed after the visit shows as done and unseen; one never visited
 * (`null`) shows nothing. Neither command is thread activity: `updatedAt` does not move.
 */

export type VisitChanged =
  | { readonly _tag: "Visited"; readonly lastVisitedAt: string }
  | { readonly _tag: "Refused"; readonly reason: string };

/**
 * The watermark after a visit at `visitedAt` (the shell's `updatedAt` the client saw): the later of
 * the kept one and it, so a replay or a visit delivered late never moves it back.
 */
export const visitedAfter = (current: string | null, visitedAt: string): VisitChanged => {
  const at = Date.parse(visitedAt);
  if (Number.isNaN(at)) {
    return { _tag: "Refused", reason: `The visit time ${visitedAt} is not a valid timestamp.` };
  }
  const visited = new Date(at).toISOString();
  return {
    _tag: "Visited",
    lastVisitedAt: current !== null && Date.parse(current) >= at ? current : visited,
  };
};

/**
 * The watermark that marks a thread unread: just before its latest run completed, so that run
 * shows as unseen again. A thread whose latest run has not completed has nothing to mark.
 */
export const markedUnread = (latestRunCompletedAt: string | null): VisitChanged => {
  if (latestRunCompletedAt === null) {
    return { _tag: "Refused", reason: "The thread has no completed run to mark unread." };
  }
  return {
    _tag: "Visited",
    lastVisitedAt: new Date(Date.parse(latestRunCompletedAt) - 1).toISOString(),
  };
};
