import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useLocation, useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, GitForkIcon, LockIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ProjectDetailDto, ProjectDto } from "#/lib/api";
import { laterPage } from "#/lib/later-pages";
import { lastProject } from "#/lib/new-session";
import { usePhone } from "#/lib/phone";
import { repositoryWords, visibleToWords } from "#/lib/projects";
import { resourcesQuery } from "#/lib/resources";
import { resourceCount } from "#/lib/resources-model";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useMinute } from "#/lib/use-inbox";

import { SidebarToggle } from "../app-sidebar.tsx";
import { RemoveProject } from "../projects/remove-project.tsx";
import { PhoneHeader } from "../workspace/phone-header.tsx";
import {
  copyAddressOf,
  OpenShellMenu,
  ProjectActionsSheet,
  ProjectMenu,
  type ProjectActions,
} from "./project-actions.tsx";
import { SetupDialog } from "./setup-dialog.tsx";

/** A tab of the project: its label, where it goes, and its count once read. */
export interface ProjectTab {
  readonly label: string;
  readonly link: LinkProps;
  /** The path it owns, to say which tab is open. */
  readonly path: string;
  readonly count: number | undefined;
}

/**
 * The project's tabs. Sessions is this route's; Worktrees, Resources and Skills are their own
 * PRs' (29, 30 and 32): each adds its route under the project and switches its `link` here from
 * `laterPage` to the route, and may give its `count`.
 */
export const projectTabs = (
  detail: ProjectDetailDto,
  counts: { readonly skills: number | undefined; readonly resources?: number | undefined },
): ReadonlyArray<ProjectTab> => {
  const id = detail.project.id;
  return [
    {
      label: "Sessions",
      link: { to: "/projects/$projectId", params: { projectId: id } },
      path: `/projects/${id}`,
      count: detail.sessions.length,
    },
    {
      label: "Worktrees",
      link: { to: "/projects/$projectId/worktrees", params: { projectId: id } },
      path: `/projects/${id}/worktrees`,
      count: detail.worktrees.length,
    },
    {
      label: "Resources",
      link: { to: "/projects/$projectId/resources", params: { projectId: id } },
      path: `/projects/${id}/resources`,
      count: counts.resources,
    },
    {
      label: "Skills",
      link: laterPage(`projects/${id}/skills`),
      path: `/projects/${id}/skills`,
      count: counts.skills,
    },
  ];
};

/** "Cloned just now", "Cloned 4h ago": said only in a project's first day. */
const addedWords = (project: ProjectDto, now: number): string | null => {
  const ms = now - project.createdAt.getTime();
  if (ms > 24 * 3_600_000) return null;
  const verb = project.originUrl === null ? "Created" : "Cloned";
  if (ms < 60_000) return `${verb} just now`;
  if (ms < 3_600_000) return `${verb} ${Math.floor(ms / 60_000)}m ago`;
  return `${verb} ${Math.floor(ms / 3_600_000)}h ago`;
};

/**
 * Who sees it, its repository and its default branch, as one line of facts. A clone that is still
 * running may not know who sees it or its default branch yet (null): those are left out.
 */
export function ProjectFacts({
  project,
  organizationName,
  extra,
  className,
}: {
  readonly project: {
    readonly visibility: ProjectDto["visibility"] | null;
    readonly originUrl: string | null;
    readonly defaultBranch: string | null;
  };
  readonly organizationName: string;
  readonly extra?: string | null;
  readonly className?: string;
}) {
  const VisibilityIcon = project.visibility === "shared" ? UsersIcon : LockIcon;
  return (
    <ul
      aria-label="About this project"
      className={cn(
        "flex flex-wrap items-center gap-x-6 gap-y-2 text-prose text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
    >
      {project.visibility === null ? null : (
        <li className="flex items-center gap-2 max-lg:hidden">
          <VisibilityIcon aria-hidden />
          {project.visibility === "shared" ? `Shared with ${organizationName}` : "Only you"}
        </li>
      )}
      <li className="flex min-w-0 items-center gap-2">
        <GitForkIcon aria-hidden />
        <span className="min-w-0 truncate font-mono text-meta text-foreground">
          {repositoryWords(project)}
        </span>
      </li>
      {project.defaultBranch === null ? null : (
        <li className="flex items-center gap-2">
          <GitBranchIcon aria-hidden />
          Default branch
          <span className="font-mono text-meta text-foreground">{project.defaultBranch}</span>
        </li>
      )}
      {extra === null || extra === undefined ? null : <li className="max-lg:hidden">{extra}</li>}
    </ul>
  );
}

/** The tabs as links (one page each), with the open one underlined. */
function TabLine({
  name,
  tabs,
  className,
}: {
  readonly name: string;
  readonly tabs: ReadonlyArray<ProjectTab>;
  readonly className?: string;
}) {
  const pathname = useLocation({ select: (location) => location.pathname.replace(/\/+$/, "") });
  return (
    <nav aria-label={`${name} project`} className={cn("flex gap-6 overflow-x-auto", className)}>
      {tabs.map((tab) => {
        const current = pathname === tab.path;
        return (
          <Link
            key={tab.label}
            {...tab.link}
            aria-current={current ? "page" : undefined}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 py-3 text-prose whitespace-nowrap outline-none focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11 max-lg:text-lead",
              current
                ? "font-medium text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="text-meta font-normal text-muted-foreground tabular-nums">
                {tab.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Every page of a project (Doop "Project · sessions" and its siblings): the header with the
 * project's name, Open shell, New session and the "…"; the tabs with their counts; the line of
 * facts under them; then the open tab. Under 1024px the header is the phone header (back to
 * Projects, the name over who sees it, the "…" as an action sheet) and the tabs scroll sideways.
 *
 * The layout route owns this frame, so moving between tabs swaps only `children`. The "Set up
 * this project" dialog is opened through the address (`?setup=1`), so the old setup page can
 * redirect to it.
 */
export function ProjectFrame({
  detail,
  setupOpen,
  onSetupOpenChange,
  children,
}: {
  readonly detail: ProjectDetailDto;
  readonly setupOpen: boolean;
  readonly onSetupOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const phone = usePhone();
  const { project } = detail;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const skills = useQuery(trpc.skills.forProject.queryOptions({ id: project.id }));
  // The Resources tab reads the same list, so its count costs nothing more there.
  const resources = useQuery(resourcesQuery(trpc, project.id, null));
  const [removing, setRemoving] = useState(false);
  const organizationName = viewer.organization.name;
  // A count not read yet, or that couldn't be read, shows nothing; the Skills tab says why.
  const tabs = projectTabs(detail, {
    skills: skills.isPending || skills.isError ? undefined : skills.data.length,
    resources: resources.isPending || resources.isError ? undefined : resourceCount(resources.data),
  });
  const actions: ProjectActions = {
    setUp: () => onSetupOpenChange(true),
    copyAddress: project.originUrl === null ? null : copyAddressOf(project.originUrl),
    // The server says who may remove it: an owner, or the creator of a private project.
    remove: detail.capabilities.remove ? () => setRemoving(true) : null,
  };
  const newSession = () => {
    lastProject.set(project.id);
    void navigate({ to: phone ? "/new" : "/" });
  };
  const now = useMinute().getTime();

  return (
    <div className="flex min-w-0 flex-col max-lg:min-h-dvh lg:min-h-0 lg:flex-1">
      <header className="shrink-0 border-b bg-background max-lg:hidden">
        <div className="flex h-header items-center gap-2 pr-2.5 pl-3">
          <SidebarToggle />
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-prose whitespace-nowrap">
            <Link
              to="/projects"
              className="shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Projects
            </Link>
            <span aria-hidden className="shrink-0 text-faint">
              /
            </span>
            <span className="min-w-0 truncate font-medium">{project.name}</span>
          </h1>
          <OpenShellMenu detail={detail} />
          <Button onClick={newSession}>New session</Button>
          <ProjectMenu detail={detail} actions={actions} />
        </div>
        <TabLine name={project.name} tabs={tabs} className="px-5" />
      </header>
      <ProjectFacts
        project={project}
        organizationName={organizationName}
        extra={addedWords(project, now)}
        className="shrink-0 border-b px-5 py-3 max-lg:hidden"
      />
      <div className="sticky top-0 z-10 shrink-0 bg-background lg:hidden">
        <PhoneHeader
          title={project.name}
          sub={visibleToWords(project.visibility, organizationName)}
          back={{ link: { to: "/projects" }, label: "Projects" }}
          actions={<ProjectActionsSheet detail={detail} actions={actions} />}
          className="border-b-0"
        />
        <TabLine name={project.name} tabs={tabs} className="border-b px-4" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      <SetupDialog
        projectId={project.id}
        projectName={project.name}
        open={setupOpen}
        onOpenChange={onSetupOpenChange}
      />
      <RemoveProject
        project={removing ? project : null}
        onOpenChange={(open) => {
          if (!open) setRemoving(false);
        }}
        onRemoved={(removed) => {
          setRemoving(false);
          toast.add({ description: `Removed ${removed.name}. Restore it from Removed projects.` });
          void navigate({ to: "/projects" });
        }}
      />
    </div>
  );
}
