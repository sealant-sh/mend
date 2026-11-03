import { cn } from "@mend/ui/lib/utils";
import { skipToken, useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useParams, useSearch } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";
import { Activity, lazy, Suspense, useCallback, useState } from "react";

import { SessionInbox } from "#/components/inbox/session-inbox";
import { AppShell } from "#/components/shell";
import { inboxQuery } from "#/lib/inbox-live";
import { withContinuation } from "#/lib/onboarding";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useSessionLayout } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { signedInOptions } from "#/lib/viewer";

/**
 * Sessions and the session they open, under one layout: the rail and the inbox are rendered here,
 * once, so moving between sessions, or between Sessions and a session, never unmounts them. Only
 * the page beside them changes. A session shown full screen hides the rail, and one laid out split
 * beside its work hides the inbox; both stay mounted underneath, so leaving that layout finds them
 * as they were.
 *
 * On a phone (below `md`) one pane shows at a time: the inbox, or the open session over the whole
 * screen. The inbox stays laid out behind the session, invisible, so it keeps its scroll position
 * for the way back.
 */
export const Route = createFileRoute("/_inbox")({
  // The inbox's reads, `ensureQueryData` against the options the inbox reads: its rows, the
  // person's marks and who they are. On the server the page waits for them, so it arrives with the
  // inbox in it; a request with no session goes to sign-in. In the browser nothing is awaited:
  // this loader runs again on every switch, reads only what is not cached yet (each keeps a stale
  // time, and the event stream patches the rows), and never holds a switch back.
  loader: async ({ context: { queryClient, trpc }, location }) => {
    const viewer = queryClient.ensureQueryData(signedInOptions(trpc));
    const reads = Promise.all([
      queryClient.ensureQueryData(inboxQuery(trpc)).catch(() => []),
      queryClient.ensureQueryData(trpc.sessions.inboxMarks.queryOptions()).catch(() => []),
    ]);
    if (typeof window !== "undefined") {
      void viewer.catch(() => null);
      return;
    }
    const signedIn = await viewer.then(
      () => true,
      (error: unknown) =>
        !(error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED"),
    );
    if (!signedIn) throw redirect({ href: withContinuation("/login", location.href) });
    await reads;
  },
  component: InboxLayout,
});

/** The session view, from the chunk its route already read ahead. */
const WarmSessionView = lazy(() =>
  import("#/components/session/session-view").then((module) => ({ default: module.SessionView })),
);

function InboxLayout() {
  const trpc = useTRPC();
  const sessionId = useParams({ strict: false, select: (params) => params.sessionId });
  const full = useSearch({ strict: false, select: (search) => search.full === true });
  const layout = useSessionLayout();
  const inSession = sessionId !== undefined;
  // The expanded rail marks the open session's project; the detail is the session page's own read.
  const projectId = useQuery({
    ...(sessionId === undefined
      ? trpc.sessions.detail.queryOptions(skipToken)
      : sessionDetailQuery(trpc, sessionId)),
    select: (detail) => detail.session.projectId,
  }).data;
  const showInbox = !inSession || (!full && layout !== "split");
  const inboxPlace = !inSession
    ? "contents"
    : cn(
        "max-md:invisible max-md:fixed max-md:inset-0 max-md:flex",
        showInbox ? "md:contents" : "md:hidden",
      );
  // The first session read ahead, rendered hidden while no session is open: the browser compiles
  // the session view's code and lays it out once, before any tap, so the first session opened
  // paints as fast as the ones after it. Hidden, it runs no effects: no subscriptions, no reads.
  const [warm, setWarm] = useState<string | null>(null);
  const onReadAhead = useCallback((id: string) => setWarm((held) => held ?? id), []);
  return (
    <AppShell layout="bare" projectId={projectId} rail={!(inSession && full)} phoneBar={!inSession}>
      <div className={inboxPlace}>
        <SessionInbox selectedId={sessionId} onReadAhead={onReadAhead} />
      </div>
      <Outlet />
      {inSession || warm === null ? null : (
        <Activity mode="hidden">
          <Suspense fallback={null}>
            <WarmSessionView sessionId={warm} tab="conversation" full={false} />
          </Suspense>
        </Activity>
      )}
    </AppShell>
  );
}
