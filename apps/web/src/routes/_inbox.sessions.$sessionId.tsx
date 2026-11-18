import { CatchBoundary, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
import { Suspense, useEffect } from "react";

import { RouteErrorScreen } from "#/components/route-screens";
import { SessionPage, SessionPending } from "#/components/session/session-sheet";
import { conversationQuery } from "#/lib/conversation";
import { sessionDetailQuery } from "#/lib/session-queries";

interface SessionSearch {
  /**
   * The old app's full screen: the conversation alone (`?full=1`). With one tile the conversation
   * already fills the sheet; PR 15 maximises the conversation's tile with it.
   */
  readonly full?: true;
  /** The old app's Desktop panel (`?view=desktop`), read only to be dropped. */
  readonly view?: "desktop";
}

/**
 * A session: its workspace's sheet, with the session's conversation as the tab of its one tile
 * (ADR 0026). Other programs open this address (the CLI, VS Code, Slack, pull request
 * descriptions), so its old forms keep working: `?view=desktop` (the old Desktop panel) lands
 * here until the Screen view exists (PR 19), and `#checkpoint-N` (a landed pull request's link)
 * scrolls to that checkpoint's marker in the conversation until the Record view takes it (PR 20).
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
    if (search.view === "desktop") {
      throw redirect({
        to: "/sessions/$sessionId",
        params,
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
  useCheckpointHash(sessionId);
  return (
    <CatchBoundary getResetKey={() => sessionId} errorComponent={RouteErrorScreen}>
      <Suspense key={sessionId} fallback={<SessionPending sessionId={sessionId} />}>
        <SessionPage key={sessionId} sessionId={sessionId} />
      </Suspense>
    </CatchBoundary>
  );
}

/**
 * `#checkpoint-N` scrolls to that checkpoint's marker once the conversation shows it. The marker
 * arrives with the conversation's first read, after the browser's own jump to the hash was tried.
 */
const useCheckpointHash = (sessionId: string) => {
  const hash = useLocation({ select: (location) => location.hash });
  // Scrolling to an element is the browser's, after it is laid out: an effect that watches for it.
  useEffect(() => {
    if (!/^checkpoint-\d+$/.test(hash)) return;
    const reach = () => {
      const marker = document.getElementById(hash);
      if (marker === null) return false;
      marker.scrollIntoView({ block: "center" });
      return true;
    };
    if (reach()) return;
    const watch = new MutationObserver(() => {
      if (reach()) watch.disconnect();
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const stop = window.setTimeout(() => watch.disconnect(), 10_000);
    return () => {
      watch.disconnect();
      window.clearTimeout(stop);
    };
  }, [hash, sessionId]);
};
