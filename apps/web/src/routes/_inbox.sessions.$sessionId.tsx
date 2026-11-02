import { CatchBoundary, createFileRoute, redirect, useChildMatches } from "@tanstack/react-router";
import { Suspense, useDeferredValue } from "react";

import { SessionFailed, SessionPending, SessionView } from "#/components/session/session-view";
import { SESSION_STALE_MS, sessionDetailQuery } from "#/lib/session-queries";
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
export const Route = createFileRoute("/_inbox/sessions/$sessionId")({
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
  // Nothing here is awaited: a switch renders at once, from the cache when the row's hover or
  // touch already read it, and the page keeps the previous session on screen until the new one's
  // detail arrives (`SessionPage`).
  loader: ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.screens.read.queryOptions({ id: params.sessionId }));
    void queryClient.prefetchQuery(trpc.organization.members.queryOptions());
    void queryClient.prefetchQuery(
      trpc.sessions.pendingFollowUp.queryOptions(
        { id: params.sessionId },
        { staleTime: SESSION_STALE_MS },
      ),
    );
    void queryClient
      .ensureQueryData(sessionDetailQuery(trpc, params.sessionId))
      .then((detail) =>
        queryClient.prefetchQuery(
          trpc.projects.detail.queryOptions({ id: detail.session.projectId }),
        ),
      )
      .catch(() => undefined);
  },
  component: SessionPage,
});

/**
 * The open session. A switch renders the new session as a deferred value: until its detail is
 * read, the previous session stays on screen, marked as switching, and the inbox already shows the
 * new row as open. A session opened from Sessions, with none on screen yet, shows the panes'
 * pending state beside the inbox instead. Cached detail renders on the next frame.
 */
function SessionPage() {
  const { sessionId } = Route.useParams();
  const { full } = Route.useSearch();
  const tab = useChildMatches({ select: (matches) => tabOfRoute(matches[0]?.routeId) });
  const shown = useDeferredValue(sessionId);
  // A session that does not load fails in its own panes; the inbox beside it stays usable.
  return (
    <CatchBoundary getResetKey={() => sessionId} errorComponent={SessionFailed}>
      <Suspense fallback={<SessionPending />}>
        <SessionView
          key={shown}
          sessionId={shown}
          tab={tab}
          full={full === true}
          switching={shown !== sessionId}
        />
      </Suspense>
    </CatchBoundary>
  );
}
