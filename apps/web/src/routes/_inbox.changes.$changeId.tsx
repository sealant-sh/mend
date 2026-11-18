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
 * only. A change no session has worked in has no session to open, and says so.
 */
export const Route = createFileRoute("/_inbox/changes/$changeId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params, location }) => {
    const opened = await queryClient.ensureQueryData(openReviewQuery(params.changeId));
    const review = await queryClient.ensureQueryData(
      trpc.changes.reviewDiff.queryOptions({ id: params.changeId, sliceId: opened.slice.id }),
    );
    if (review.change.sessionId !== null)
      throw redirect({
        to: "/sessions/$sessionId/$view",
        params: { sessionId: review.change.sessionId, view: "change" },
        hash: location.hash,
        replace: true,
      });
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
