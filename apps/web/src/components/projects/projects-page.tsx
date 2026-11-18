import { canRemoveProject } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@mend/ui/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { createToastManager, Toaster } from "@mend/ui/components/ui/toast";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { clonePercent } from "#/lib/adoptions";
import type { ProjectDto } from "#/lib/api";
import { lastProject } from "#/lib/new-session";
import { usePhone } from "#/lib/phone";
import {
  matchesFilter,
  matchesQuery,
  openSessionCounts,
  type ProjectsFilter,
  shortOrigin,
} from "#/lib/projects";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useClone } from "#/lib/use-clone";
import { useInbox } from "#/lib/use-inbox";

import { PhoneTabBar } from "../phone-inbox.tsx";
import { AddProject } from "./add-project.tsx";
import {
  type CloneEntry,
  type ProjectActions,
  type ProjectEntry,
  ProjectsList,
  ProjectsTable,
} from "./projects-table.tsx";
import { RemoveProject } from "./remove-project.tsx";
import { RemovedProjects } from "./removed-projects.tsx";

/** The page's own toasts: removed, restored, copied. */
const toasts = createToastManager();
const say = (description: string) => toasts.add({ description });

/**
 * Projects (Doop "Projects · list", "Phone · Projects"): every project the person can see, to
 * search and filter, open, start a session in, or remove; the clone this browser started while it
 * runs or after it failed; and Removed projects under the list. Add project… clones a repository
 * or makes an empty project.
 */
export function ProjectsPage() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  // The route's loader read these; a failure there is the route's error screen.
  const projects = useSuspenseQuery(trpc.projects.list.queryOptions()).data;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const membersRead = useQuery(trpc.organization.members.queryOptions());
  const sessions = useQuery(trpc.sessions.listActive.queryOptions());
  const inbox = useInbox();
  const clone = useClone(viewer.userId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectsFilter>("all");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectDto | null>(null);
  // Add project… opens on the form, unless a clone is running or failed unseen: then on that.
  const openAdd = () => {
    if (clone.state?._tag === "Added" || clone.state?._tag === "Gone") clone.forget();
    setAdding(true);
  };

  const organizationName = viewer.organization.name;
  // A roster that failed to read again keeps the names it had; until then nobody is named.
  const members =
    membersRead.isPending || membersRead.isError ? (membersRead.data ?? []) : membersRead.data;
  const counts = openSessionCounts(
    sessions.isPending || sessions.isError ? undefined : sessions.data,
  );
  const actions: ProjectActions = {
    newSession: (project) => {
      lastProject.set(project.id);
      void navigate({ to: phone ? "/new" : "/" });
    },
    copyAddress: (project) => {
      if (project.originUrl === null) return;
      navigator.clipboard.writeText(project.originUrl).then(
        () => say(`Copied ${shortOrigin(project.originUrl ?? "")}.`),
        () => say("The browser didn't allow copying. Select the address on the project's page."),
      );
    },
    remove: setRemoving,
  };
  const entries: ReadonlyArray<ProjectEntry> = projects
    .filter((project) => matchesFilter(project, filter) && matchesQuery(project, query))
    .map((project) => ({
      project,
      open: sessions.isError
        ? null
        : (counts?.get(project.id) ?? (counts === undefined ? undefined : 0)),
      addedBy:
        members.find((member) => member.userId === project.createdByUserId)?.name ??
        (membersRead.isSuccess ? null : undefined),
      actions: canRemoveProject(project, {
        userId: viewer.userId,
        organizationId: viewer.organization.id,
        role: viewer.role,
      })
        ? actions
        : { ...actions, remove: null },
    }));

  const { attempt, state } = clone;
  const cloneEntry: CloneEntry | null =
    attempt === null ||
    state === null ||
    (state._tag !== "Cloning" && state._tag !== "Failed") ||
    query.trim() !== "" ||
    (filter === "shared" && attempt.visibility !== "shared")
      ? null
      : {
          name: attempt.name,
          source: attempt.source === null ? "" : shortOrigin(attempt.source),
          state,
          percent: state._tag === "Cloning" ? clonePercent(state.progress) : null,
          onOpen: () => setAdding(true),
        };
  const filtering = query.trim() !== "" || filter !== "all";
  const nothingYet = projects.length === 0 && cloneEntry === null;
  const intro = `Repositories added to ${organizationName} that you can see.`;
  const waiting = inbox.status === "success" ? inbox.view.groups.waiting.length : 0;

  return (
    <Toaster toastManager={toasts} size={phone ? "touch" : "default"}>
      <div className="flex min-w-0 flex-col max-lg:min-h-dvh max-lg:pb-14 lg:h-[calc(100dvh-2*var(--spacing-sheet-inset))] lg:flex-none">
        <header className="flex h-header shrink-0 items-center gap-3 border-b bg-background pr-2.5 pl-5 max-lg:sticky max-lg:top-0 max-lg:z-10 max-lg:h-auto max-lg:border-0 max-lg:pt-3 max-lg:pr-1 max-lg:pb-1 max-lg:pl-4">
          <h1 className="flex-1 text-prose font-semibold max-lg:text-2xl max-lg:tracking-tight">
            Projects
          </h1>
          <Button className="max-lg:hidden" onClick={openAdd}>
            Add project…
          </Button>
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label="Add project"
            className="lg:hidden"
            onClick={openAdd}
          >
            <PlusIcon aria-hidden className="size-6" />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:px-8 lg:pt-6 lg:pb-12">
          {nothingYet ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>
                  <h2>No projects yet</h2>
                </EmptyTitle>
                <EmptyDescription>
                  A project is a repository Mend cloned onto this server. Sessions run in it.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size={phone ? "touch" : "default"} onClick={openAdd}>
                  Add project…
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <p className="mb-3.5 text-prose text-muted-foreground max-lg:hidden">
                {intro} Each session works in its own worktree on this server.
              </p>
              <div className="mb-2 flex items-center gap-2.5 max-lg:mb-2 max-lg:px-4">
                <InputGroup className="w-72 max-lg:h-11 max-lg:w-full max-lg:border-0 max-lg:bg-muted">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden className="size-4 max-lg:size-5" />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    aria-label="Search projects"
                    placeholder="Search projects"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="max-lg:text-lead"
                  />
                </InputGroup>
                <Tabs
                  value={filter}
                  onValueChange={(value: ProjectsFilter) => setFilter(value)}
                  className="max-lg:hidden"
                >
                  <TabsList aria-label="Show">
                    <TabsTrigger value="all" className="px-2.5">
                      All
                    </TabsTrigger>
                    <TabsTrigger value="shared" className="px-2.5">
                      Shared
                    </TabsTrigger>
                    <TabsTrigger value="private" className="px-2.5">
                      Only you
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <p role="status" className="text-row text-muted-foreground max-lg:sr-only">
                  {filtering ? `${entries.length} of ${projects.length}` : ""}
                </p>
              </div>
              {entries.length === 0 && cloneEntry === null ? (
                <p className="py-6 text-prose text-muted-foreground max-lg:px-4">
                  No project matches.{" "}
                  <Button
                    variant="link"
                    className="text-prose"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Show all projects
                  </Button>
                </p>
              ) : (
                <>
                  <div className="max-lg:hidden">
                    <ProjectsTable
                      entries={entries}
                      clone={cloneEntry}
                      organizationName={organizationName}
                    />
                  </div>
                  <div className="lg:hidden">
                    <ProjectsList
                      entries={entries}
                      clone={cloneEntry}
                      organizationName={organizationName}
                    />
                  </div>
                </>
              )}
              {sessions.isError ? (
                <p className="mt-3 text-row text-muted-foreground max-lg:px-4">
                  Open sessions couldn't be read.{" "}
                  <Button
                    variant="link"
                    className="text-row"
                    onClick={() => void sessions.refetch()}
                  >
                    Try again
                  </Button>
                </p>
              ) : null}
              <p className="px-4 pt-4 text-prose text-muted-foreground lg:hidden">{intro}</p>
              <div className="max-lg:px-4">
                <RemovedProjects
                  organizationName={organizationName}
                  members={members}
                  onRestored={(name) => say(`Restored ${name}.`)}
                />
              </div>
            </>
          )}
        </div>
        <div className="lg:hidden">
          <PhoneTabBar active="projects" badge={waiting} />
        </div>
      </div>
      <AddProject
        open={adding}
        onOpenChange={setAdding}
        clone={clone}
        projects={projects}
        organizationName={organizationName}
        onAdded={(project) => say(`Added ${project.name}.`)}
      />
      <RemoveProject
        project={removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        onRemoved={(project) => {
          setRemoving(null);
          say(`Removed ${project.name}. Restore it from Removed projects.`);
        }}
      />
    </Toaster>
  );
}
