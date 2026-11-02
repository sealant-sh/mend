import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { FirstRun } from "#/components/first-run";
import { WorkspacesRefusedNotice } from "#/components/host-user-namespaces";
import { SessionInbox } from "#/components/inbox/session-inbox";
import { PROMPT_ID, SessionComposer } from "#/components/session-composer";
import { AppShell } from "#/components/shell";
import { useTRPC } from "#/lib/trpc";

export const Route = createFileRoute("/")({
  ssr: false,
  // Every read the inbox makes starts here at once: the project list and the person's marks
  // together, then each project's detail. Prefetches never throw, so one unreachable project
  // degrades to a line in the inbox instead of an error page.
  loader: async ({ context: { queryClient, trpc } }) => {
    void queryClient.prefetchQuery(trpc.sessions.inboxMarks.queryOptions());
    const projects = await queryClient
      .ensureQueryData(trpc.projects.list.queryOptions())
      .catch(() => []);
    await Promise.all(
      projects.map((project) =>
        queryClient.prefetchQuery(trpc.projects.detail.queryOptions({ id: project.id })),
      ),
    );
  },
  component: SessionsHome,
});

/**
 * Sessions, the home page (screens S1 to S3): the inbox on the left and, with no session open,
 * "What should an agent work on?" over the composer. Before any project is adopted, the first-run
 * steps take the composer's place.
 */
function SessionsHome() {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  useNewSessionKey();
  return (
    <AppShell layout="bare">
      <SessionInbox />
      <main className="flex min-h-screen min-w-0 flex-1 flex-col items-center justify-center px-14 pb-20">
        <div className="w-full max-w-[680px]">
          <WorkspacesRefusedNotice />
        </div>
        {projects.isPending ? (
          <p role="status" className="font-mono text-[12px] text-muted-foreground">
            Reading projects…
          </p>
        ) : projects.isError ? (
          <p role="alert" className="font-mono text-[12px] text-danger">
            Projects did not load: {projects.error.message}
          </p>
        ) : projects.data.length === 0 ? (
          <div className="w-full max-w-[680px]">
            <FirstRun />
          </div>
        ) : (
          <>
            <h1 className="mb-[22px] text-center font-display text-[32px] leading-tight font-semibold tracking-[-0.02em]">
              What should an agent work on?
            </h1>
            <div className="w-full max-w-[680px]">
              <SessionComposer projects={projects.data} autoFocus />
            </div>
          </>
        )}
      </main>
    </AppShell>
  );
}

/** `c` anywhere on the page outside a text field puts the cursor in the composer. */
function useNewSessionKey() {
  // A page-wide shortcut has to listen on the document for as long as the page is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      const prompt = document.getElementById(PROMPT_ID);
      if (prompt === null) return;
      event.preventDefault();
      prompt.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
