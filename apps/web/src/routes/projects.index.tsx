import { useContextMenu } from "@mend/ui/context-menu";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AdoptPanel } from "#/components/projects-index/adopt-panel";
import { ProjectsDirectory } from "#/components/projects-index/layout-directory";
import {
  matchesQuery,
  projectEntries,
  type ProjectMenuHandler,
} from "#/components/projects-index/model";
import { AppShell } from "#/components/shell";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";
import { useWorkbenchEvents } from "#/lib/workbench-events";
import { projectMenu } from "#/lib/workbench-menus";

/** The adopted-project directory and its URL-only adoption entry point. */
export const Route = createFileRoute("/projects/")({
  ssr: false,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(context.trpc.projects.list.queryOptions());
  },
  component: ProjectsPage,
});

/** Searchable directory of repositories adopted into this machine's store. */
function ProjectsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const launchContext = { queryClient, trpc };
  const viewer = useViewer();
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  const activeSessions = useQuery(trpc.sessions.listActive.queryOptions()).data;
  const navigate = useNavigate();
  const { openMenu, menuElement } = useContextMenu();
  const [query, setQuery] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);
  useWorkbenchEvents();

  const allEntries = projectEntries(projects, activeSessions);
  const entries = allEntries.filter(({ project }) => matchesQuery(project, query));
  const live =
    activeSessions === undefined
      ? null
      : allEntries.reduce((total, entry) => total + (entry.live ?? 0), 0);

  const onProjectMenu: ProjectMenuHandler = (event, project) =>
    openMenu(event, projectMenu(project, navigate, launchContext, viewer));

  return (
    <AppShell>
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <p className="ev-eyebrow">store</p>
            <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground">
              Projects
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Repositories in Mend&apos;s store, with worktrees and their sessions.
            </p>
            {projects.length > 0 && (
              <p className="mt-2 font-mono text-[11.5px] text-faint">
                {projects.length} adopted
                {live === null
                  ? " · session activity unavailable"
                  : ` · ${live} session${live === 1 ? "" : "s"} live`}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-expanded={adoptOpen}
            aria-controls="adopt-panel"
            onClick={() => setAdoptOpen((open) => !open)}
            className="mt-1 shrink-0 rounded-xl border border-border bg-card px-3.5 py-2 font-sans text-[13px] font-medium text-foreground shadow-xs transition-transform hover:-translate-y-0.5"
          >
            {adoptOpen ? "Close" : "Adopt a repository"}
          </button>
        </div>

        <div id="adopt-panel" className="mt-6" hidden={!adoptOpen}>
          <AdoptPanel onAdopted={() => setAdoptOpen(false)} />
        </div>

        {projects.length === 0 ? (
          <p className="mt-8 text-sm text-muted-foreground">
            Nothing adopted yet. Use the adoption button above, or{" "}
            <span className="font-mono text-xs">mend adopt</span> from a repository.
          </p>
        ) : (
          <>
            <div className="mt-8 flex items-center gap-3">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Filter projects by name, origin or store path"
                placeholder="Filter by name, origin or path"
                className="w-full min-w-0 max-w-[340px] rounded-lg border border-input bg-background px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-faint"
              />
              {query.trim() !== "" && (
                <p className="shrink-0 font-mono text-[11.5px] text-faint" aria-live="polite">
                  {entries.length} of {projects.length}
                </p>
              )}
            </div>
            <div className="mt-5">
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No project matches <span className="font-mono text-xs">{query.trim()}</span>.{" "}
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="font-sans text-sm font-medium text-info underline-offset-2 hover:underline"
                  >
                    clear the filter
                  </button>
                  .
                </p>
              ) : (
                <ProjectsDirectory entries={entries} onProjectMenu={onProjectMenu} />
              )}
            </div>
          </>
        )}
      </div>
      {menuElement}
    </AppShell>
  );
}
