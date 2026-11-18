import { Banner } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mend/ui/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@mend/ui/components/ui/sidebar";
import { cn } from "@mend/ui/lib/utils";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
  WifiOffIcon,
} from "lucide-react";
import { Fragment, memo, type ReactNode, useState } from "react";

import {
  activity,
  age,
  EMPTY_GROUP,
  GROUP_ROWS,
  INBOX_GROUPS,
  type InboxGroup,
  type InboxRow,
  type QueuedRow,
  readAt,
  rowStatus,
  sharedWith,
} from "#/lib/inbox";
import { laterPage } from "#/lib/later-pages";
import { sessionLink } from "#/lib/session-sheet";
import { useServerHost } from "#/lib/online";
import { inboxFolds } from "#/lib/ui-prefs";
import { type InboxState, type InboxView } from "#/lib/use-inbox";

import { InboxFilterMenu } from "./inbox-filters.tsx";
import { QueuedSidebarRow } from "./queued-session-row.tsx";

/**
 * The app's left sidebar on the desk (Doop "App sidebar", "Sidebar group", "Sidebar row"): the
 * organization, search and New session, Projects and Skills, the inbox's filters and its five
 * groups, then Settings and the account. It is the only inbox: every list of a person's sessions
 * lives here, grouped by what they need.
 *
 * Seams for the PRs after this one: the organization row and the account row take the switcher
 * and the account menu (PR 9), and a row's `actions` take its "…" menu (PR 8).
 */

/** The sidebar's width on the desk, as the canvas draws it. */
export const SIDEBAR_WIDTH = "264px";

/** Which item of the sidebar's navigation the open page is, from its path. */
export type SidebarArea = "inbox" | "projects" | "skills" | "settings";

export const areaOf = (pathname: string): SidebarArea => {
  if (pathname.startsWith("/projects")) return "projects";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/settings")) return "settings";
  return "inbox";
};

/** The open session's id, when the page is one of its views. */
export const openSessionOf = (pathname: string): string | undefined =>
  /^\/sessions\/([^/]+)/.exec(pathname)?.[1];

/** "AL" for Ada Lovelace; the first letter of an email when there is no name. */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/** On the desk, a control's own ground: the background showing through. */
const RAISED = "bg-background/72";
/** What pointing at an item on the desk shows. */
const HOVER = "hover:bg-background/55";

const navClass = cn(
  "h-8 gap-2.5 rounded-lg px-2 text-row font-medium text-foreground [&_svg]:text-muted-foreground",
  HOVER,
  "data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground",
);

export function AppSidebar({
  organizationName,
  accountName,
  inbox,
  online,
  className,
}: {
  readonly organizationName: string;
  readonly accountName: string;
  /** The inbox's reads; the sidebar draws their loading, failure and empty states. */
  readonly inbox: InboxState;
  readonly online: boolean;
  readonly className?: string;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const area = areaOf(pathname);
  const host = useServerHost();
  return (
    <Sidebar
      collapsible="none"
      aria-label="Sidebar"
      className={cn(
        "sticky top-0 h-dvh shrink-0 bg-sidebar pt-3 pr-2 pb-2.5 pl-3 text-sidebar-foreground tabular-nums",
        className,
      )}
    >
      <SidebarHeader className="gap-0 p-0">
        <div className="flex h-9 items-center gap-2 px-2 text-prose font-semibold">
          <span
            aria-hidden
            className="grid size-5.5 shrink-0 place-items-center rounded-md bg-foreground text-xs font-bold text-background"
          >
            {initialsOf(organizationName).slice(0, 1)}
          </span>
          <span className="min-w-0 truncate">{organizationName}</span>
        </div>
        <div className="my-2.5 flex gap-1.5">
          {/* Search arrives with the command palette; until then the field is drawn, not offered. */}
          <div
            aria-hidden
            className={cn(
              "flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-muted-foreground",
              RAISED,
            )}
          >
            <SearchIcon className="size-4" />
            <span className="flex-1 text-row">Search</span>
            <kbd className="font-sans text-2xs font-medium">⌘K</kbd>
          </div>
          <Link
            to="/"
            aria-label="New session"
            title="New session"
            className={cn(
              "grid size-8.5 shrink-0 place-items-center rounded-lg text-foreground outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50",
              RAISED,
            )}
          >
            <SquarePenIcon aria-hidden className="size-4" />
          </Link>
        </div>
        <SidebarMenu aria-label="Pages">
          <NavItem to="projects" icon={<FolderIcon />} active={area === "projects"}>
            Projects
          </NavItem>
          <NavItem to="skills" icon={<SparklesIcon />} active={area === "skills"}>
            Skills
          </NavItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="mt-2 gap-0">
        <SidebarInbox inbox={inbox} online={online} openId={openSessionOf(pathname)} host={host} />
      </SidebarContent>
      <SidebarFooter className="gap-0.5 border-t border-sidebar-border p-0 pt-2">
        <SidebarMenu>
          <NavItem to="settings" icon={<SettingsIcon />} active={area === "settings"}>
            Settings
          </NavItem>
        </SidebarMenu>
        <div className="flex items-center gap-2.5 p-2">
          <span
            aria-hidden
            className="grid size-7.5 shrink-0 place-items-center rounded-full bg-sidebar-accent text-2xs font-semibold"
          >
            {initialsOf(accountName)}
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-row font-semibold">{accountName}</span>
            <span className="truncate text-meta text-muted-foreground">{host}</span>
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function NavItem({
  to,
  icon,
  active,
  children,
}: {
  readonly to: "projects" | "skills" | "settings";
  readonly icon: ReactNode;
  readonly active: boolean;
  readonly children: string;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        className={navClass}
        render={<Link {...laterPage(to)} aria-current={active ? "page" : undefined} />}
      >
        {icon}
        <span>{children}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The filters, the offline band, then the inbox's groups, or what stands in for them. */
function SidebarInbox({
  inbox,
  online,
  openId,
  host,
}: {
  readonly inbox: InboxState;
  readonly online: boolean;
  readonly openId: string | undefined;
  readonly host: string;
}) {
  switch (inbox.status) {
    case "pending":
      return (
        <p role="status" className="px-2 pt-3 text-row text-muted-foreground">
          {host === "" ? "Loading your sessions…" : `Loading your sessions from ${host}…`}
        </p>
      );
    case "error":
      return (
        <div role="alert" className="flex flex-col items-start gap-2 px-2 pt-3 text-row">
          <p>
            <span className="font-medium">Your sessions didn't load.</span>{" "}
            <span className="text-muted-foreground">{messageOf(inbox.error)}</span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={inbox.retrying}
            onClick={inbox.retry}
          >
            {inbox.retrying ? "Trying again…" : "Try again"}
          </Button>
        </div>
      );
    case "success":
      return <InboxGroups view={inbox.view} online={online} openId={openId} />;
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";

/** The offline band: what the inbox shows is from when it was last read. */
export function OfflineBand({
  view,
  layout,
  onRetry,
}: {
  readonly view: InboxView;
  readonly layout: "inline" | "stacked";
  readonly onRetry: () => void;
}) {
  return (
    <Banner
      tone="info"
      layout={layout}
      icon={<WifiOffIcon />}
      title="You're offline."
      actions={
        <Button type="button" variant="link" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      This is your inbox from {readAt(view.readAt)}. You can read sessions you've opened, but
      answering, approving and starting sessions need a connection.
    </Banner>
  );
}

function InboxGroups({
  view,
  online,
  openId,
}: {
  readonly view: InboxView;
  readonly online: boolean;
  readonly openId: string | undefined;
}) {
  const folds = inboxFolds.use();
  return (
    <>
      <div className="mb-1.5 px-0.5">
        <InboxFilterMenu filters={view.filters} />
      </div>
      {online ? null : <OfflineBand view={view} layout="stacked" onRetry={view.refresh} />}
      <nav aria-label="Inbox" className="min-h-0 flex-1 overflow-y-auto pt-1.5 pb-2">
        {view.empty ? (
          <p className="px-2 pt-1 text-row text-muted-foreground">
            No sessions yet. Start one with New session, and the sessions that need you show here.
          </p>
        ) : (
          INBOX_GROUPS.map(({ group, label }) => (
            <SidebarInboxGroup
              key={group}
              group={group}
              label={label}
              rows={view.groups[group]}
              queued={queuedIn(view, group)}
              open={folds[group]}
              onOpenChange={(open) => inboxFolds.set({ ...folds, [group]: open })}
              all={view.all}
              now={view.now}
              openId={openId}
            />
          ))
        )}
      </nav>
    </>
  );
}

/** The queued sessions a group lists before its sessions: Running's waiting, To review's failed. */
export const queuedIn = (view: InboxView, group: InboxGroup): ReadonlyArray<QueuedRow> =>
  group === "running" || group === "review" ? view.queued[group] : [];

/** One group: its heading (name, count, fold) and its rows, the first five, then "Show N more". */
function SidebarInboxGroup({
  group,
  label,
  rows,
  queued,
  open,
  onOpenChange,
  all,
  now,
  openId,
}: {
  readonly group: InboxGroup;
  readonly label: string;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly queued: ReadonlyArray<QueuedRow>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly all: ReadonlyArray<InboxRow>;
  readonly now: Date;
  readonly openId: string | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  // The open session stays listed, wherever it falls in its group.
  const openIndex = rows.findIndex((row) => row.session.id === openId);
  const shown =
    showAll || rows.length <= GROUP_ROWS
      ? rows
      : rows.filter((_, index) => index < GROUP_ROWS || index === openIndex);
  const more = rows.length - shown.length;
  const wait = group === "waiting" && rows.length > 0;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-fold={open ? "open" : "closed"}
      className="data-[fold=open]:pb-1.5 [[data-fold=closed]+&]:data-[fold=open]:mt-1.5"
      render={<section aria-label={label} />}
    >
      <SidebarGroup className="p-0">
        <CollapsibleTrigger
          className={cn(
            "group/fold flex h-8 w-full items-center gap-1.5 rounded-lg pr-2 pl-1 text-left text-row font-semibold text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            HOVER,
          )}
        >
          {open ? (
            <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
          )}
          <span className={cn("min-w-0 truncate", wait && "text-warning")}>{label}</span>
          <span
            className={cn(
              "ml-auto text-meta font-medium text-muted-foreground",
              wait && "text-warning",
            )}
          >
            {rows.length + queued.length}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent>
            {queued.length === 0 ? null : (
              <SidebarMenu>
                {queued.map((row) => (
                  <QueuedSidebarRow key={row.id} row={row} now={now} />
                ))}
              </SidebarMenu>
            )}
            {rows.length === 0 && queued.length === 0 ? (
              <p className="py-2.5 pr-2 pl-4 text-row text-muted-foreground">
                {EMPTY_GROUP[group]}
              </p>
            ) : rows.length === 0 ? null : (
              <SidebarMenu>
                {shown.map((row) => (
                  <InboxRowItem
                    key={row.session.id}
                    row={row}
                    shared={sharedWith(row, all)}
                    now={now}
                    active={row.session.id === openId}
                  />
                ))}
              </SidebarMenu>
            )}
            {more > 0 ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="block rounded-md pt-1 pr-2 pb-1.5 pl-6 text-control font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Show {more} more
              </button>
            ) : null}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

const InboxRowItem = memo(function InboxRowItem({
  row,
  shared,
  now,
  active,
}: {
  readonly row: InboxRow;
  readonly shared: number | null;
  readonly now: Date;
  readonly active: boolean;
}) {
  const status = rowStatus(row, now);
  return (
    <SidebarRow
      sessionId={row.session.id}
      title={row.title}
      project={row.project.name}
      status={status.word}
      failed={status.failed}
      age={row.group === "snoozed" ? "" : age(new Date(activity(row)), now)}
      note={
        shared === null ? undefined : (
          <>
            {row.worktreeName ?? <span className="font-mono text-2xs">{row.session.branch}</span>} ·{" "}
            {shared} sessions
          </>
        )
      }
      active={active}
    />
  );
});

/**
 * One session in the inbox (Doop "Sidebar row"): its title, then one muted line of project, what
 * it is doing or how it ended, and how long ago, and an optional note line (the workspace it
 * shares). Only "Failed" is red. The row opens the session; `actions` is where its "…" goes.
 */
export function SidebarRow({
  sessionId,
  title,
  project,
  status,
  failed = false,
  age: ago,
  note,
  active = false,
  actions,
}: {
  readonly sessionId: string;
  readonly title: string;
  readonly project: string;
  readonly status: string;
  readonly failed?: boolean;
  /** "4m", "now"; empty drops it. */
  readonly age: string;
  readonly note?: ReactNode;
  readonly active?: boolean;
  readonly actions?: ReactNode;
}) {
  const parts = [
    { key: "project", text: project, className: "" },
    { key: "status", text: status, className: failed ? "text-destructive" : "" },
    { key: "age", text: ago, className: "" },
  ].filter((part) => part.text !== "");
  return (
    <SidebarMenuItem className="group/row">
      <SidebarMenuButton
        isActive={active}
        className={cn(
          "block h-auto rounded-lg pt-1.5 pr-2 pb-1.75 pl-6 leading-snug font-normal",
          HOVER,
          "data-active:bg-sidebar-accent",
          actions === undefined ? "" : "group-hover/row:pr-9 group-focus-within/row:pr-9",
        )}
        render={
          <Link
            {...sessionLink(sessionId)}
            data-session-id={sessionId}
            aria-current={active ? "page" : undefined}
          />
        }
      >
        <span
          className={cn(
            "block truncate text-row text-foreground",
            active ? "font-medium" : "opacity-86",
          )}
        >
          {title}
        </span>
        <span className="mt-px block truncate text-meta text-muted-foreground">
          {parts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 ? " · " : ""}
              <span className={part.className}>{part.text}</span>
            </Fragment>
          ))}
        </span>
        {note === undefined ? null : (
          <span className="mt-px block truncate text-meta text-muted-foreground">{note}</span>
        )}
      </SidebarMenuButton>
      {actions === undefined ? null : (
        <span className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 group-focus-within/row:flex group-hover/row:flex">
          {actions}
        </span>
      )}
    </SidebarMenuItem>
  );
}
