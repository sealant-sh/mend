import {
  CatchBoundary,
  createFileRoute,
  redirect,
  useLocation,
  useParams,
} from "@tanstack/react-router";
import { Suspense, useEffect } from "react";

import { RouteErrorScreen } from "#/components/route-screens";
import { SessionPage, SessionPending } from "#/components/session/session-sheet";
import { StartingSessionPage } from "#/components/session/starting-session";
import { checkpointOfHash } from "#/lib/checkpoint-link";
import { conversationQuery } from "#/lib/conversation";
import { isDraftId } from "#/lib/pending-starts";
import { sessionDetailQuery } from "#/lib/session-queries";

interface SessionSearch {
  /** The old app's full screen (`?full=1`): the tile showing the session's conversation, maximised. */
  readonly full?: true;
  /** The old app's Desktop panel (`?view=desktop`): the Screen view now. */
  readonly view?: "desktop";
}

/**
 * A session: its workspace's sheet, with the session's conversation tab showing and focused
 * (ADR 0026). Other programs open this address (the CLI, VS Code, Slack, pull request
 * descriptions), so its old forms keep working: `?view=desktop` (the old Desktop panel) opens the
 * Screen view, and `#checkpoint-N` (a landed pull request's link)
 * opens the Record view with that checkpoint in view and marked.
 */
export const Route = createFileRoute("/_inbox/sessions/$sessionId")({
  validateSearch: (search: Record<string, unknown>): SessionSearch => ({
    // `?full=1` reads as the number 1; `full: true` from a link writes `?full=true`.
    ...(search["full"] === true || search["full"] === 1 || search["full"] === "1"
      ? { full: true }
      : null),
    ...(search["view"] === "desktop" ? { view: "desktop" } : null),
  }),
  beforeLoad: ({ search, location, params }) => {
    const atSession = location.pathname.replace(/\/$/, "") === `/sessions/${params.sessionId}`;
    if (atSession && checkpointOfHash(location.hash) !== null) {
      throw redirect({
        to: "/sessions/$sessionId/$view",
        params: { sessionId: params.sessionId, view: "record" },
        hash: location.hash,
        replace: true,
      });
    }
    if (search.view === "desktop") {
      throw redirect({
        to: "/sessions/$sessionId/$view",
        params: { sessionId: params.sessionId, view: "screen" },
        search: search.full === true ? { full: true } : {},
        hash: location.hash,
        replace: true,
      });
    }
  },
  // What the first paint needs, against the options the page reads: the session's detail and the
  // newest window of its conversation. On the server the page waits for them; in the browser a
  // switch never does, and a session nothing read yet shows its inbox row's facts while they
  // arrive.
  loader: async ({ context: { queryClient, trpc, trpcClient }, params }) => {
    // A start this tab is making has nothing on the server to read yet.
    if (isDraftId(params.sessionId)) return;
    const firstPaint = Promise.all([
      queryClient.ensureQueryData(sessionDetailQuery(trpc, params.sessionId)),
      queryClient.ensureInfiniteQueryData(conversationQuery(trpc, trpcClient, params.sessionId)),
    ]);
    if (typeof window !== "undefined") {
      void firstPaint.catch(() => undefined);
      return;
    }
    await firstPaint;
  },
  errorComponent: RouteErrorScreen,
  component: SessionRoute,
});

function SessionRoute() {
  const { sessionId } = Route.useParams();
  const full = Route.useSearch({ select: (search) => search.full === true });
  // A view's own address (`/sessions/<id>/terminal`, the child route) names the tab to show.
  const view = useParams({ strict: false, select: (params) => params.view });
  const navigate = Route.useNavigate();
  useCheckpointLink(sessionId, view);
  if (isDraftId(sessionId)) return <StartingSessionPage draftId={sessionId} />;
  return (
    <CatchBoundary getResetKey={() => sessionId} errorComponent={RouteErrorScreen}>
      {/* Not keyed by the session: the page keeps its sheet across the sessions of one workspace. */}
      <Suspense fallback={<SessionPending sessionId={sessionId} />}>
        <SessionPage
          sessionId={sessionId}
          {...(view === undefined ? {} : { view })}
          full={full}
          onLeaveFull={() =>
            void navigate({ search: {}, hash: (hash) => hash ?? "", replace: true })
          }
        />
      </Suspense>
    </CatchBoundary>
  );
}

/**
 * `#checkpoint-N` on the session's own address opens the Record view at that checkpoint. The
 * server never sees a hash, so a page loaded with one moves here once it runs in the browser; a
 * move inside the app is redirected before it loads.
 */
const useCheckpointLink = (sessionId: string, view: string | undefined) => {
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (view !== undefined || checkpointOfHash(hash) === null) return;
    void navigate({
      to: "/sessions/$sessionId/$view",
      params: { sessionId, view: "record" },
      hash,
      replace: true,
    });
  }, [hash, navigate, sessionId, view]);
};
