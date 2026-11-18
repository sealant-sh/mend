import { buttonVariants } from "@mend/ui/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@mend/ui/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mend/ui/components/ui/table";
import { cn } from "@mend/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ProjectDto } from "#/lib/api";
import type { CloneState } from "#/lib/clone-state";
import { laterPage } from "#/lib/later-pages";
import { openSessionsWords, repositoryWords, visibleToWords } from "#/lib/projects";

import { initialsOf } from "../app-sidebar.tsx";

/** What the row menu can do with one project; each the page's to carry out. */
export interface ProjectActions {
  readonly newSession: (project: ProjectDto) => void;
  readonly copyAddress: (project: ProjectDto) => void;
  /** Null when the viewer can't remove this project. */
  readonly remove: ((project: ProjectDto) => void) | null;
}

/** One project as the table and the phone list show it. */
export interface ProjectEntry {
  readonly project: ProjectDto;
  /** Its open sessions; undefined until they are read, null when they couldn't be. */
  readonly open: number | null | undefined;
  /** Who added it, by name; null when they are no longer a member, undefined until the roster is read. */
  readonly addedBy: string | null | undefined;
  readonly actions: ProjectActions;
}

/** The clone this browser started, while it runs or after it failed, as a row of its own. */
export interface CloneEntry {
  readonly name: string;
  readonly source: string;
  readonly state: Extract<CloneState, { readonly _tag: "Cloning" | "Failed" }>;
  readonly percent: number | null;
  readonly onOpen: () => void;
}

const openWords = (open: number | null | undefined): string =>
  open === undefined ? "" : open === null ? "Not known" : String(open);

/**
 * The desktop Projects table (Doop "Project row"): the project over its repository, who can see
 * it, its open sessions, its default branch, who added it, and a "…" for its menu, which a
 * right-click on the row opens too.
 */
export function ProjectsTable({
  entries,
  clone,
  organizationName,
}: {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly clone: CloneEntry | null;
  readonly organizationName: string;
}) {
  return (
    <Table aria-label="Projects" className="text-prose">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-10 pl-0 font-normal text-muted-foreground">Project</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Visible to</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Open sessions</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Default branch</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Added by</TableHead>
          <TableHead className="w-10 pr-0">
            <span className="sr-only">Menu</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="[&_tr:last-child]:border-b">
        {clone === null ? null : <CloneTableRow clone={clone} />}
        {entries.map((entry) => (
          <ProjectRow key={entry.project.id} entry={entry} organizationName={organizationName} />
        ))}
      </TableBody>
    </Table>
  );
}

const CELL = "h-14.5 px-3";

export function ProjectRow({
  entry,
  organizationName,
}: {
  readonly entry: ProjectEntry;
  readonly organizationName: string;
}) {
  const { project, open, addedBy, actions } = entry;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<TableRow />}>
        <TableCell className={cn(CELL, "max-w-80 pl-0")}>
          <Link
            {...laterPage(`projects/${project.id}`)}
            className="block truncate font-medium outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {project.name}
          </Link>
          <span className="block truncate font-mono text-2xs text-muted-foreground">
            {repositoryWords(project)}
          </span>
        </TableCell>
        <TableCell className={CELL}>
          {visibleToWords(project.visibility, organizationName)}
        </TableCell>
        <TableCell className={cn(CELL, "text-muted-foreground")}>{openWords(open)}</TableCell>
        <TableCell className={cn(CELL, "font-mono text-meta")}>{project.defaultBranch}</TableCell>
        <TableCell className={CELL}>
          {addedBy === undefined ? null : addedBy === null ? (
            <span className="text-muted-foreground">A former member</span>
          ) : (
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="grid size-5.5 shrink-0 place-items-center rounded-full bg-muted text-2xs font-medium"
              >
                {initialsOf(addedBy)}
              </span>
              {addedBy}
            </span>
          )}
        </TableCell>
        <TableCell className={cn(CELL, "w-10 pr-0")}>
          <ProjectMenu project={project} actions={actions} />
        </TableCell>
      </ContextMenuTrigger>
      <ContextMenuContent width="sm">
        <MenuItems kind="context" project={project} actions={actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CloneTableRow({ clone }: { readonly clone: CloneEntry }) {
  const failed = clone.state._tag === "Failed";
  return (
    <TableRow>
      <TableCell className={cn(CELL, "max-w-80 pl-0")}>
        <button
          type="button"
          onClick={clone.onOpen}
          className="block max-w-full truncate text-left font-medium outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {clone.name}
        </button>
        <span className="block truncate font-mono text-2xs text-muted-foreground">
          {clone.source}
        </span>
      </TableCell>
      <TableCell className={cn(CELL, "text-muted-foreground")} />
      <TableCell className={cn(CELL, failed ? "text-destructive" : "text-muted-foreground")}>
        {failed
          ? "Clone failed"
          : clone.percent === null
            ? "Cloning"
            : `Cloning · ${clone.percent}%`}
      </TableCell>
      <TableCell className={CELL} />
      <TableCell className={CELL} />
      <TableCell className={cn(CELL, "w-10 pr-0")} />
    </TableRow>
  );
}

/** The "…" on a project row: the same items as its right-click menu. */
export function ProjectMenu({
  project,
  actions,
  touch = false,
}: {
  readonly project: ProjectDto;
  readonly actions: ProjectActions;
  readonly touch?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${project.name} menu`}
        className={cn(
          buttonVariants({ variant: "ghost", size: touch ? "icon-touch" : "icon" }),
          "text-muted-foreground",
        )}
      >
        <EllipsisIcon aria-hidden className={touch ? "size-5.5" : "size-4"} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="sm">
        <MenuItems kind="dropdown" project={project} actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItems({
  kind,
  project,
  actions,
}: {
  readonly kind: "dropdown" | "context";
  readonly project: ProjectDto;
  readonly actions: ProjectActions;
}) {
  const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  const { remove } = actions;
  return (
    <>
      <Item render={<Link {...laterPage(`projects/${project.id}`)} />}>Open project</Item>
      <Item onClick={() => actions.newSession(project)}>New session</Item>
      {project.originUrl === null ? null : (
        <Item onClick={() => actions.copyAddress(project)}>Copy repository address</Item>
      )}
      {remove === null ? null : (
        <>
          <Separator />
          <Item variant="destructive" onClick={() => remove(project)}>
            Remove project…
          </Item>
        </>
      )}
    </>
  );
}

/**
 * The phone's Projects list (Doop "Phone · Projects"): each project's name over who can see it
 * and its open sessions, with the project's menu.
 */
export function ProjectsList({
  entries,
  clone,
  organizationName,
}: {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly clone: CloneEntry | null;
  readonly organizationName: string;
}) {
  return (
    <ul aria-label="Projects" className="border-y">
      {clone === null ? null : (
        <PhoneRow>
          <button
            type="button"
            onClick={clone.onOpen}
            className="flex min-h-16 min-w-0 flex-1 flex-col justify-center py-2.5 pl-4 text-left outline-none focus-visible:bg-muted"
          >
            <span className="truncate text-lead">{clone.name}</span>
            <span
              className={cn(
                "truncate text-prose",
                clone.state._tag === "Failed" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {clone.state._tag === "Failed"
                ? "Clone failed"
                : clone.percent === null
                  ? "Cloning"
                  : `Cloning · ${clone.percent}%`}
            </span>
          </button>
        </PhoneRow>
      )}
      {entries.map(({ project, open, actions }) => (
        <PhoneRow key={project.id}>
          <Link
            {...laterPage(`projects/${project.id}`)}
            className="flex min-h-16 min-w-0 flex-1 flex-col justify-center py-2.5 pl-4 outline-none focus-visible:bg-muted"
          >
            <span className="truncate text-lead">{project.name}</span>
            <span className="truncate text-prose text-muted-foreground">
              {visibleToWords(project.visibility, organizationName)}
              {typeof open === "number" ? ` · ${openSessionsWords(open)}` : ""}
            </span>
          </Link>
          <ProjectMenu project={project} actions={actions} touch />
        </PhoneRow>
      ))}
    </ul>
  );
}

function PhoneRow({ children }: { readonly children: ReactNode }) {
  return <li className="flex items-center gap-1 border-b pr-1 last:border-b-0">{children}</li>;
}
