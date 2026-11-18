import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { FileDiffIcon } from "lucide-react";

import { RouteErrorScreen } from "#/components/route-screens";
import { openReviewQuery } from "#/lib/review-open";

/**
 * A change's own address, which pull request descriptions, the CLI (`mend` review links and the
 * review screen's `o`), Slack's "Review in Mend" and VS Code hand out: the change is reviewed in
 * its session's Change view now, so the address goes there, `#land` and any other hash kept.
 *
 * It opens the review with this browser tab's key, as the Change view does, so the view finds the
 * same slice already open. The key lives in the tab's sessionStorage, so this runs in the browser
 * only. A change no session has worked in has no session to open (the server opens no review of
 * it), and says so.
 */
export const Route = createFileRoute("/_inbox/changes/$changeId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params, location }) => {
    const toSession = (sessionId: string) =>
      redirect({
        to: "/sessions/$sessionId/$view",
        params: { sessionId, view: "change" },
        hash: location.hash,
        replace: true,
      });
    const opened = await queryClient
      .ensureQueryData(openReviewQuery(params.changeId))
      .catch((cause: unknown) => ({ refused: cause }));
    if ("refused" in opened) {
      // The server opens no review of a worktree no session has worked in: read the change as it
      // is to tell that apart from a failure, which the error screen shows.
      const live = await queryClient.fetchQuery(
        trpc.changes.diff.queryOptions({ id: params.changeId }),
      );
      if (live.change.sessionId === null) return;
      throw opened.refused;
    }
    const review = await queryClient.ensureQueryData(
      trpc.changes.reviewDiff.queryOptions({ id: params.changeId, sliceId: opened.slice.id }),
    );
    if (review.change.sessionId !== null) throw toSession(review.change.sessionId);
  },
  errorComponent: RouteErrorScreen,
  component: NoSessionYet,
});

function NoSessionYet() {
  return (
    <div className="mx-auto w-full max-w-140 px-5 pt-10 pb-10 md:pt-16">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileDiffIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h1>Nothing to review yet</h1>
          </EmptyTitle>
          <EmptyDescription>
            No session has worked in this worktree yet, so there is no session to open.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
