import { skipToken, useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useParams, useSearch } from "@tanstack/react-router";

import { SessionInbox } from "#/components/inbox/session-inbox";
import { AppShell } from "#/components/shell";
import { sessionDetailQuery } from "#/lib/session-queries";
import { sessionLayout } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";

/**
 * Sessions and the session they open, under one layout: the rail and the inbox are rendered here,
 * once, so moving between sessions, or between Sessions and a session, never unmounts them. Only
 * the page beside them changes. A session shown full screen hides the rail, and one laid out split
 * beside its work hides the inbox; both stay mounted underneath, so leaving that layout finds them
 * as they were.
 */
export const Route = createFileRoute("/_inbox")({
  ssr: false,
  // Every read the inbox makes starts here at once: the project list and the person's marks
  // together, then each project's detail. Nothing is awaited, so a navigation into the layout
  // never waits on the inbox: it shows what is cached and reads the rest in place. This loader
  // runs again on every switch, so it only reads what is not cached yet: a stale read refetched
  // here would share a request batch with the session being opened and hold it back, and the
  // event stream already re-reads what changed. One unreachable project degrades to a line in the
  // inbox.
  loader: ({ context: { queryClient, trpc } }) => {
    void queryClient.ensureQueryData(trpc.sessions.inboxMarks.queryOptions()).catch(() => []);
    void queryClient
      .ensureQueryData(trpc.projects.list.queryOptions())
      .then((projects) =>
        Promise.allSettled(
          projects.map((project) =>
            queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: project.id })),
          ),
        ),
      )
      .catch(() => undefined);
  },
  component: InboxLayout,
});

function InboxLayout() {
  const trpc = useTRPC();
  const sessionId = useParams({ strict: false, select: (params) => params.sessionId });
  const full = useSearch({ strict: false, select: (search) => search.full === true });
  const layout = sessionLayout.use();
  const inSession = sessionId !== undefined;
  // The expanded rail marks the open session's project; the detail is the session page's own read.
  const projectId = useQuery({
    ...(sessionId === undefined
      ? trpc.sessions.detail.queryOptions(skipToken)
      : sessionDetailQuery(trpc, sessionId)),
    select: (detail) => detail.session.projectId,
  }).data;
  const showInbox = !inSession || (!full && layout !== "split");
  return (
    <AppShell layout="bare" projectId={projectId} rail={!(inSession && full)}>
      <div className={showInbox ? "contents" : "hidden"}>
        <SessionInbox selectedId={sessionId} />
      </div>
      <Outlet />
    </AppShell>
  );
}
