import { useContextMenu } from "@mend/ui/context-menu";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type MouseEvent } from "react";

import { Button, focusRing } from "#/components/kit/button";
import { Chip } from "#/components/kit/controls";
import { Icon } from "#/components/kit/icons";
import { Page, PageHeader } from "#/components/kit/page";
import { Panel } from "#/components/kit/section";
import { StatusWord } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import { originWords } from "#/components/project/project-frame";
import { AdoptDialog } from "#/components/projects-index/adopt-dialog";
import { adoptedLabel, matchesQuery, projectEntries } from "#/components/projects-index/model";
import { RemovedProjects } from "#/components/removed-projects";
import { AppShell } from "#/components/shell";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";
import { projectMenu } from "#/lib/workbench-menus";

/** The adopted projects (screen J1) and Adopt a repository (J2). */
export const Route = createFileRoute("/projects/")({
  ssr: false,
  loader: async ({ context }) => {
    void context.queryClient.prefetchQuery(context.trpc.sessions.listActive.queryOptions());
    await context.queryClient.ensureQueryData(context.trpc.projects.list.queryOptions());
  },
  component: ProjectsPage,
});

const FILTER_ID = "projects-filter";

/** Every project adopted into Mend's store, filterable by what you remember of it. */
function ProjectsPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const viewer = useViewer();
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  const activeSessions = useQuery(trpc.sessions.listActive.queryOptions());
  const navigate = useNavigate();
  const { openMenu, menuElement } = useContextMenu();
  const [query, setQuery] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);

  const allEntries = projectEntries(projects, activeSessions.data);
  const entries = allEntries.filter(({ project }) => matchesQuery(project, query));
  const live =
    activeSessions.data === undefined
      ? null
      : allEntries.reduce((total, entry) => total + (entry.live ?? 0), 0);
  const filtering = query.trim() !== "";

  // A right-click anywhere on a row opens that project's menu, as it did on the old directory.
  const onRowMenu = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return;
    const id = event.target.closest('[role="row"]')?.querySelector("[data-project-id]");
    const project = projects.find((row) => row.id === id?.getAttribute("data-project-id"));
    if (project === undefined) return;
    openMenu(event, projectMenu(project, navigate, { queryClient, trpc }, viewer));
  };

  return (
    <AppShell layout="bare">
      <Page
        head={
          <PageHeader
            eyebrow="projects"
            title="Projects"
            className="mb-[18px]"
            description={
              projects.length === 0
                ? "Repositories in Mend's store, with worktrees and their sessions."
                : `${projects.length} adopted · ${
                    live === null
                      ? activeSessions.isError
                        ? "session activity unavailable"
                        : "reading sessions…"
                      : `${live} session${live === 1 ? "" : "s"} live`
                  }`
            }
            actions={
              <Button variant="primary" aria-haspopup="dialog" onClick={() => setAdoptOpen(true)}>
                Adopt a repository
              </Button>
            }
          />
        }
      >
        {projects.length === 0 ? (
          <Panel className="px-[26px] py-6">
            <p className="text-[13.5px] text-ink-2">
              Nothing adopted yet. Adopt a repository from GitHub or any git URL, or run{" "}
              <span className="font-mono text-[12.5px]">mend adopt</span> in a checkout.
            </p>
            <Button className="mt-4" variant="primary" onClick={() => setAdoptOpen(true)}>
              Adopt a repository
            </Button>
          </Panel>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-3">
              <div className="flex w-[320px] items-center gap-2.5 rounded-[10px] bg-secondary py-[7px] pr-2.5 pl-3 text-faint focus-within:ring-2 focus-within:ring-ring/30">
                <Icon name="search" size={14} />
                <label htmlFor={FILTER_ID} className="sr-only">
                  Filter projects by name, origin or path
                </label>
                <input
                  id={FILTER_ID}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by name, origin or path"
                  className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-foreground outline-none placeholder:text-faint"
                />
              </div>
              <p role="status" className="font-mono text-[11.5px] text-faint">
                {filtering ? `${entries.length} of ${projects.length}` : ""}
              </p>
            </div>
            {entries.length === 0 ? (
              <p className="text-[13.5px] text-muted-foreground">
                No project matches <span className="font-mono text-[12.5px]">{query.trim()}</span>.{" "}
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className={cn(
                    "font-medium text-info underline-offset-2 hover:underline",
                    focusRing,
                  )}
                >
                  Clear the filter
                </button>
              </p>
            ) : (
              <Panel className="px-1 py-1.5">
                <div onContextMenu={onRowMenu}>
                  <DataTable
                    label="Projects"
                    // The facts take what their values need, up to a cap; the name and origin
                    // take the rest. The minimums add up to a phone's 36rem row.
                    columns={[
                      { head: "Repository", width: "minmax(11rem,1fr)" },
                      { head: "Default branch", width: "minmax(5rem,10rem)" },
                      { head: "Adopted", width: "minmax(4.5rem,7rem)" },
                      { head: "Sessions", width: "minmax(6rem,8.5rem)" },
                      { head: "Visible to", width: "minmax(4.5rem,7rem)" },
                    ]}
                    rows={entries.map(({ project, live: count }) => ({
                      key: project.id,
                      cells: [
                        <span key="name" className="grid min-w-0 gap-0.5">
                          <Link
                            to="/projects/$projectId"
                            params={{ projectId: project.id }}
                            data-project-id={project.id}
                            className={cn(
                              "w-fit max-w-full truncate rounded-sm font-medium text-foreground no-underline hover:underline",
                              focusRing,
                            )}
                          >
                            {project.name}
                          </Link>
                          <span
                            className="truncate font-mono text-[12px] text-muted-foreground"
                            title={project.originUrl ?? project.storePath}
                          >
                            {originWords(project)}
                          </span>
                        </span>,
                        <span
                          key="branch"
                          className="block truncate font-mono text-[12px] text-ink-2"
                          title={project.defaultBranch}
                        >
                          {project.defaultBranch}
                        </span>,
                        <span key="adopted" className="font-mono text-[12px] text-muted-foreground">
                          {adoptedLabel(project)}
                        </span>,
                        count === null ? (
                          <StatusWord key="live" tone={null}>
                            {activeSessions.isError ? "unavailable" : "…"}
                          </StatusWord>
                        ) : (
                          <StatusWord key="live" tone={count > 0 ? "run" : "off"}>
                            {count > 0 ? `${count} live` : "none live"}
                          </StatusWord>
                        ),
                        <Chip key="visibility">{project.visibility}</Chip>,
                      ],
                    }))}
                  />
                </div>
              </Panel>
            )}
          </>
        )}
        <RemovedProjects />
      </Page>
      <AdoptDialog open={adoptOpen} onOpenChange={setAdoptOpen} projects={projects} />
      {menuElement}
    </AppShell>
  );
}
