import { createFileRoute } from "@tanstack/react-router";

import { openReviewQuery } from "#/lib/review-open";
import { sessionDetailQuery } from "#/lib/session-queries";

/**
 * The Change tab (screens P2, C2, X1): the review. Opening it opens the change's review once per
 * browser tab, then reads the slice's diff, its comments and what Mend ran over it, all at once.
 * Each read is a prefetch: a failure shows in the tab, beside the rest of the session.
 */
export const Route = createFileRoute("/_inbox/sessions/$sessionId/change")({
  // Not awaited: the tab shows at once and each read fills its own part of it.
  loader: ({ context: { queryClient, trpc }, params }) => {
    void (async () => {
      const detail = await queryClient.ensureQueryData(sessionDetailQuery(trpc, params.sessionId));
      const change = detail.change;
      if (change === null) return;
      void queryClient.prefetchQuery(trpc.changes.comments.queryOptions({ id: change.id }));
      void queryClient.prefetchQuery(trpc.changes.passes.queryOptions({ id: change.id }));
      void queryClient.prefetchQuery(trpc.changes.tour.queryOptions({ id: change.id }));
      void queryClient.prefetchQuery(trpc.landings.forChange.queryOptions({ id: change.id }));
      const opened = await queryClient.fetchQuery(openReviewQuery(change.id));
      void queryClient.prefetchQuery(
        trpc.changes.reviewDiff.queryOptions({ id: change.id, sliceId: opened.slice.id }),
      );
    })().catch(() => undefined);
  },
});
