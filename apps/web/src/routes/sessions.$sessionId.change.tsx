import { createFileRoute } from "@tanstack/react-router";

import {
  opensCurrentChange,
  openReviewQuery,
  renewReviewOpenKeyFrom,
  reviewOpenKey,
} from "#/lib/review-open";

/**
 * The Change tab (screens P2, C2, X1): the review. Opening it opens the change's review once per
 * browser tab, then reads the slice's diff, its comments and what Mend ran over it, all at once.
 * A slice pinned on an earlier visit that the worktree has moved past opens as the change is now.
 * Each read is a prefetch: a failure shows in the tab, beside the rest of the session.
 */
export const Route = createFileRoute("/sessions/$sessionId/change")({
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const detail = await queryClient.ensureQueryData(
      trpc.sessions.detail.queryOptions({ id: params.sessionId }),
    );
    const change = detail.change;
    if (change === null) return;
    void queryClient.prefetchQuery(trpc.changes.comments.queryOptions({ id: change.id }));
    void queryClient.prefetchQuery(trpc.changes.passes.queryOptions({ id: change.id }));
    void queryClient.prefetchQuery(trpc.changes.tour.queryOptions({ id: change.id }));
    void queryClient.prefetchQuery(trpc.landings.forChange.queryOptions({ id: change.id }));
    // The key this open reads under: a later open (the banner's "Review the change as it is
    // now") replaces it, and nothing below then moves the review again.
    const openedWith = reviewOpenKey(change.id);
    const opened = await queryClient
      .fetchQuery(openReviewQuery(change.id, openedWith))
      .catch(() => null);
    if (opened === null) return;
    const diff = trpc.changes.reviewDiff.queryOptions({ id: change.id, sliceId: opened.slice.id });
    // A slice this tab pinned on an earlier visit that the worktree has since moved past opens
    // as the change is now, unless anything on it is still to send (`opensCurrentChange`).
    const reopen = async () => {
      const [pinned, comments] = await Promise.all([
        queryClient.fetchQuery(diff).catch(() => null),
        queryClient
          .fetchQuery(trpc.changes.comments.queryOptions({ id: change.id }))
          .catch(() => null),
      ]);
      if (pinned !== null && opensCurrentChange(pinned, change.id, opened.slice.id, comments))
        renewReviewOpenKeyFrom(change.id, openedWith);
    };
    void reopen();
  },
});
