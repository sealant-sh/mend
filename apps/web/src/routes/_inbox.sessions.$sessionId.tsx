import { CatchBoundary, createFileRoute, redirect, useChildMatches } from "@tanstack/react-router";
import { Suspense } from "react";

import { SessionFailed, SessionPending, SessionView } from "#/components/session/session-view";
import { conversationQuery } from "#/lib/conversation";
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
  // What the first paint needs, `ensureQueryData` against the same options the page reads: the
  // header (the session's detail) and the conversation's first page. Both keep a real stale time,
  // so a preloaded or visited session is a cache hit and paints on the next frame without reading
  // again. On the server the page waits for them; in the browser a switch never does: a session
  // nothing read yet shows its row's own facts at once (`SessionPending`) while they arrive.
  loader: async ({ context: { queryClient, trpc, trpcClient }, params }) => {
    const server = typeof window === "undefined";
    if (!server)
      void queryClient.prefetchQuery(trpc.screens.read.queryOptions({ id: params.sessionId }));
    const beside = [
      queryClient.prefetchQuery(trpc.organization.members.queryOptions()),
      queryClient.prefetchQuery(
        trpc.sessions.pendingFollowUp.queryOptions(
          { id: params.sessionId },
          { staleTime: SESSION_STALE_MS },
        ),
      ),
    ];
    const firstPaint = Promise.all([
      queryClient
        .ensureQueryData(sessionDetailQuery(trpc, params.sessionId))
        .then((detail) =>
          queryClient.prefetchQuery(
            trpc.projects.detail.queryOptions({ id: detail.session.projectId }),
          ),
        ),
      queryClient.ensureInfiniteQueryData(conversationQuery(trpc, trpcClient, params.sessionId)),
    ]);
    if (!server) {
      void firstPaint.catch(() => undefined);
      return;
    }
    // A page rendered on the server arrives with its header, its latest messages and the names.
    await Promise.all([firstPaint, ...beside]);
  },
  // A page rendered on the server whose session did not load fails in its own panes.
  errorComponent: SessionFailed,
  component: SessionPage,
});

/**
 * The open session, from the cache its loader filled. The boundary is the session's own, so a
 * switch to a session nothing read yet shows that session's row facts on the next frame instead of
 * holding the previous one; a cached session renders straight through it.
 */
function SessionPage() {
  const { sessionId } = Route.useParams();
  const { full } = Route.useSearch();
  const tab = useChildMatches({ select: (matches) => tabOfRoute(matches[0]?.routeId) });
  return (
    <CatchBoundary getResetKey={() => sessionId} errorComponent={SessionFailed}>
      <Suspense key={sessionId} fallback={<SessionPending sessionId={sessionId} />}>
        <SessionView key={sessionId} sessionId={sessionId} tab={tab} full={full === true} />
      </Suspense>
    </CatchBoundary>
  );
}
