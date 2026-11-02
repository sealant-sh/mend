import { createFileRoute, redirect, useChildMatches } from "@tanstack/react-router";

import { SessionView } from "#/components/session/session-view";
import { tabOfRoute } from "#/lib/session-view";

interface SessionSearch {
  /** Full screen (screens X6 and X7): the page is the conversation, centred, with a tab line. */
  readonly full?: true;
  /** The old page's Desktop panel; it is the Screen tab now. */
  readonly view?: "desktop";
}

/**
 * A session (screens P, C and X): its conversation and five more tabs, each a child route with its
 * own URL. This route lays them out and never renders an outlet, so switching tabs keeps the
 * conversation's scroll, the terminal and the screen connected, and the child routes only load
 * what their tab reads.
 */
export const Route = createFileRoute("/sessions/$sessionId")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): SessionSearch => ({
    // `?full=1` reads as the number 1; `full: true` from a link writes `?full=true`.
    ...(search["full"] === true || search["full"] === 1 || search["full"] === "1"
      ? { full: true }
      : {}),
    ...(search["view"] === "desktop" ? { view: "desktop" } : {}),
  }),
  beforeLoad: ({ search, location, params }) => {
    if (search.view === "desktop") {
      throw redirect({ to: "/sessions/$sessionId/screen", params, replace: true });
    }
    // A landed pull request links a checkpoint as `#checkpoint-N` (docs/adr/0007-landing.md): the
    // Record tab lists it.
    const onConversation = location.pathname.replace(/\/$/, "") === `/sessions/${params.sessionId}`;
    if (onConversation && /^checkpoint-\d+$/.test(location.hash)) {
      throw redirect({
        to: "/sessions/$sessionId/record",
        params,
        hash: location.hash,
        replace: true,
      });
    }
  },
  loader: async ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.screens.read.queryOptions({ id: params.sessionId }));
    void queryClient.prefetchQuery(trpc.organization.members.queryOptions());
    const detail = await queryClient.ensureQueryData(
      trpc.sessions.detail.queryOptions({ id: params.sessionId }),
    );
    void queryClient.prefetchQuery(
      trpc.projects.detail.queryOptions({ id: detail.session.projectId }),
    );
  },
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { full } = Route.useSearch();
  const tab = useChildMatches({ select: (matches) => tabOfRoute(matches[0]?.routeId) });
  return <SessionView key={sessionId} sessionId={sessionId} tab={tab} full={full === true} />;
}
