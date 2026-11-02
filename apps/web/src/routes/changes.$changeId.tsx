import { createFileRoute, redirect } from "@tanstack/react-router";

import { Page, PageHeader } from "#/components/kit/page";
import { AppShell } from "#/components/shell";
import { openReviewQuery } from "#/lib/review-open";

/**
 * A change's old address. Review lives in its session's Change tab now; links Mend already gave
 * out (pull request descriptions, Slack, the CLI) land there, `#land` included. A change no
 * conversation has inhabited has no session to open, and says so.
 */
export const Route = createFileRoute("/changes/$changeId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params, location }) => {
    const opened = await queryClient.ensureQueryData(openReviewQuery(params.changeId));
    const review = await queryClient.ensureQueryData(
      trpc.changes.reviewDiff.queryOptions({ id: params.changeId, sliceId: opened.slice.id }),
    );
    if (review.change.sessionId !== null) {
      throw redirect({
        to: "/sessions/$sessionId/change",
        params: { sessionId: review.change.sessionId },
        hash: location.hash,
        replace: true,
      });
    }
  },
  component: NoSessionYet,
});

function NoSessionYet() {
  return (
    <AppShell layout="bare">
      <Page>
        <PageHeader
          eyebrow="change"
          title="Nothing to review yet"
          description="No conversation has worked in this worktree, so there is no session to open."
        />
      </Page>
    </AppShell>
  );
}
