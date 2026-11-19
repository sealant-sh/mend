import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@mend/ui/components/ui/sidebar";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, ChevronsUpDownIcon } from "lucide-react";

import {
  groupName,
  pageAt,
  type SettingsGroup,
  type SettingsPage,
  type SettingsPageId,
  type SettingsViewer,
  visiblePages,
} from "#/lib/settings-pages";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { SETTINGS_ICONS, settingsLink } from "./settings-links.tsx";

/** The settings sidebar's width on the desk, as the canvas draws it. */
export const SETTINGS_SIDEBAR_WIDTH = "272px";

/** A project the Projects group can open. */
export interface SettingsProject {
  readonly id: string;
  readonly name: string;
}

/**
 * What both lists of Settings read (the sidebar on the desk, the Settings tab on a phone): who is
 * looking, the organization's name and head count, and the projects this person can open. The
 * signed-in layout's loader already read each.
 */
export const useSettingsNav = (): {
  readonly viewer: SettingsViewer;
  readonly organizationName: string;
  readonly members: number | undefined;
  readonly projects: ReadonlyArray<SettingsProject>;
} => {
  const trpc = useTRPC();
  const view = useSuspenseQuery(signedInOptions(trpc)).data;
  const { organizationName } = useViewer();
  const members = useQuery(trpc.organization.members.queryOptions());
  const projects = useQuery(trpc.projects.list.queryOptions());
  return {
    viewer: { role: view.role, operator: view.operator },
    organizationName,
    // A count beside Members, not something to wait for: none until the roster answers, and a
    // roster that failed to read again keeps the count it had.
    members:
      members.isPending || (members.isError && members.data === undefined)
        ? undefined
        : members.data?.length,
    // A list that can't be read leaves the Projects group out; a project page still opens by its
    // own address.
    projects: projects.isPending || projects.isError ? (projects.data ?? []) : projects.data,
  };
};

/** The page an address shows in Settings: `/settings` itself opens Profile. */
export const openSettingsPage = (
  pathname: string,
): { readonly id: SettingsPageId; readonly projectId?: string | undefined } => {
  const at = pageAt(pathname);
  return at === null ? { id: "a-profile" } : { id: at.page.id, projectId: at.projectId };
};

const itemClass = cn(
  "h-8 gap-2 rounded-md px-2 text-row text-sidebar-foreground [&_svg]:size-4 [&_svg]:text-sidebar-foreground",
  "hover:bg-sidebar-accent data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground",
);

/**
 * The sidebar of Settings on the desk (Doop "Settings sidebar"), in place of the app's sidebar on
 * every settings page: Back to app, then Account, This device, the organization by name, Projects
 * (a picker whose pages open under the project being edited) and, for the server's operators,
 * Server. A page a person may not open isn't listed (`mayOpen`): the organization's Projects and
 * Audit log are its owners', Server its operators'.
 */
export function SettingsSidebar() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { viewer, organizationName, members, projects } = useSettingsNav();
  const open = openSettingsPage(pathname);
  const names = { organization: organizationName };
  const groups: ReadonlyArray<Exclude<SettingsGroup, "project">> = [
    "account",
    "device",
    "organization",
  ];
  return (
    <Sidebar
      collapsible="none"
      aria-label="Settings"
      style={{ "--sidebar-width": SETTINGS_SIDEBAR_WIDTH }}
      className="sticky top-0 h-svh shrink-0 bg-sidebar pt-3 pr-2.5 pb-2.5 pl-3 text-sidebar-foreground tabular-nums"
    >
      <SidebarHeader className="p-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className={itemClass} render={<Link to="/" />}>
              <ArrowLeftIcon aria-hidden />
              <span>Back to app</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {groups.map((group) => (
          <PageGroup
            key={group}
            label={groupName(group, names)}
            pages={visiblePages(group, viewer)}
            open={open.id}
            counts={{ "o-members": members }}
          />
        ))}
        {projects.length === 0 ? null : (
          <ProjectsGroup
            projects={projects}
            viewer={viewer}
            openId={open.id}
            openProject={open.projectId}
          />
        )}
        {viewer.operator ? (
          <PageGroup
            label={groupName("server", names)}
            pages={visiblePages("server", viewer)}
            open={open.id}
            counts={{}}
          />
        ) : null}
      </SidebarContent>
    </Sidebar>
  );
}

function PageGroup({
  label,
  pages,
  open,
  counts,
}: {
  readonly label: string;
  readonly pages: ReadonlyArray<SettingsPage>;
  readonly open: SettingsPageId;
  readonly counts: Partial<Record<SettingsPageId, number | undefined>>;
}) {
  return (
    <SidebarGroup className="mt-3 p-0">
      <SidebarGroupLabel className="h-7.5 px-2 text-meta font-semibold text-muted-foreground">
        {label}
      </SidebarGroupLabel>
      <SidebarMenu aria-label={label} className="gap-0">
        {pages.map((page) => {
          const active = page.id === open;
          const count = counts[page.id];
          return (
            <SidebarMenuItem key={page.id}>
              <SidebarMenuButton
                isActive={active}
                className={itemClass}
                render={
                  <Link
                    {...settingsLink(page.id)}
                    aria-current={active ? "page" : undefined}
                    aria-label={count === undefined ? undefined : `${page.label}, ${count}`}
                  />
                }
              >
                {SETTINGS_ICONS[page.id]}
                <span className="min-w-0 flex-1 truncate">{page.label}</span>
                {count === undefined ? null : (
                  <span aria-hidden className="text-xs text-muted-foreground">
                    {count}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * Projects (Doop "Settings sidebar", the project switcher): one project at a time, the one being
 * edited, or the first. Its pages open under it while one of them is open; the switcher picks
 * another project and opens its General page.
 */
function ProjectsGroup({
  projects,
  viewer,
  openId,
  openProject,
}: {
  readonly projects: ReadonlyArray<SettingsProject>;
  readonly viewer: SettingsViewer;
  readonly openId: SettingsPageId;
  readonly openProject: string | undefined;
}) {
  const navigate = useNavigate();
  const shown = projects.find((project) => project.id === openProject) ?? projects[0];
  if (shown === undefined) return null;
  const expanded = openProject === shown.id;
  return (
    <SidebarGroup className="mt-3 p-0">
      <SidebarGroupLabel className="h-7.5 px-2 text-meta font-semibold text-muted-foreground">
        Projects
      </SidebarGroupLabel>
      <div className="mb-1 flex h-8.5 items-center rounded-lg bg-background/72 font-semibold">
        <Link
          {...settingsLink("p-general", shown.id)}
          aria-expanded={expanded}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-lg pl-2 text-row outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{shown.name}</span>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Switch project, ${shown.name}`}
            className="grid h-full w-8 shrink-0 place-items-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronsUpDownIcon aria-hidden className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent width="anchor" align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={shown.id}
                onValueChange={(value: unknown) => {
                  if (typeof value === "string") void navigate(settingsLink("p-general", value));
                }}
              >
                {projects.map((project) => (
                  <DropdownMenuRadioItem key={project.id} value={project.id} closeOnClick>
                    {project.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded ? (
        <SidebarMenuSub
          aria-label={shown.name}
          className="mx-0 ml-3.75 gap-0 border-sidebar-border"
        >
          {visiblePages("project", viewer).map((page) => {
            const active = page.id === openId;
            return (
              <SidebarMenuSubItem key={page.id}>
                <SidebarMenuSubButton
                  isActive={active}
                  className="h-7 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground"
                  render={
                    <Link
                      {...settingsLink(page.id, shown.id)}
                      aria-current={active ? "page" : undefined}
                    />
                  }
                >
                  <span className="truncate">{page.label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      ) : null}
    </SidebarGroup>
  );
}
