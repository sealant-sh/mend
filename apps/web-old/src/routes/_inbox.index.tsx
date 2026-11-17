import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { FirstRun } from "#/components/first-run";
import { WorkspacesRefusedNotice } from "#/components/host-user-namespaces";
import { SessionComposer } from "#/components/session-composer";
import { PROMPT_ID } from "#/lib/inbox";
import { useTRPC } from "#/lib/trpc";

export const Route = createFileRoute("/_inbox/")({
  // The composer names the projects to start in; on the server the page waits for them.
  loader: async ({ context: { queryClient, trpc } }) => {
    const projects = queryClient.prefetchQuery(trpc.projects.list.queryOptions());
    if (typeof window === "undefined") await projects;
  },
  component: SessionsHome,
});

/**
 * Sessions, the home page (screens S1 to S3): beside the layout's inbox, with no session open,
 * "What should an agent work on?" over the composer. Before any project is adopted, the first-run
 * steps take the composer's place. On a phone the composer sits under the inbox, at the foot of
 * the screen, the way a message box does.
 */
function SessionsHome() {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  useNewSessionKey();
  return (
    <main className="flex min-h-dvh min-w-0 flex-1 flex-col items-center justify-center px-14 pb-20 max-md:max-h-[80%] max-md:min-h-0 max-md:flex-none max-md:items-stretch max-md:justify-start max-md:overflow-y-auto max-md:border-t max-md:border-rule max-md:px-3 max-md:pt-3 max-md:pb-3">
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
          <h1 className="mb-[22px] text-center font-display text-[32px] leading-tight font-semibold tracking-[-0.02em] max-md:mb-2.5 max-md:px-1 max-md:text-left max-md:text-[17px]">
            What should an agent work on?
          </h1>
          <div className="w-full max-w-[680px]">
            <SessionComposer projects={projects.data} autoFocus />
          </div>
        </>
      )}
    </main>
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
