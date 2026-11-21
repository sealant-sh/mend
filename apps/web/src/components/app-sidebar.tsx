import { Banner } from "@mend/ui/components/banner";
import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { Button } from "@mend/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mend/ui/components/ui/collapsible";
import { ContextMenu, ContextMenuTrigger } from "@mend/ui/components/ui/context-menu";
import { Kbd } from "@mend/ui/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@mend/ui/components/ui/popover";
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
  SidebarRail,
  useSidebar,
} from "@mend/ui/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@mend/ui/components/ui/tooltip";
import { cn } from "@mend/ui/lib/utils";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  InboxIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
  WifiOffIcon,
} from "lucide-react";
import {
  Fragment,
  memo,
  type ReactElement,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { useMacDesktopTitlebarInset } from "#/lib/desktop";
import {
  activity,
  age,
  EMPTY_GROUP,
  INBOX_GROUPS,
  type InboxGroup,
  type InboxRow,
  type QueuedRow,
  railRows,
  readAt,
  rowLump,
  rowPr,
  rowStatus,
  sharedWith,
  shownRows,
} from "#/lib/inbox";
import { useServerHost } from "#/lib/online";
import { isPendingRow } from "#/lib/pending-starts";
import { rowActions } from "#/lib/row-actions";
import { useKeys } from "#/lib/search-keys";
import { sessionLink } from "#/lib/session-sheet";
import { type ShownRow, useSidebarMoves } from "#/lib/sidebar-moves";
import { inboxFolds } from "#/lib/ui-prefs";
import { type InboxState, type InboxView } from "#/lib/use-inbox";
import { useRowActions } from "#/lib/use-row-actions";

import { type Account, AccountMenu } from "./account-menu.tsx";
import { Changed } from "./changed.tsx";
import { useOpenSearch } from "./command-palette.tsx";
import { InboxFilterMenu } from "./inbox-filters.tsx";
import { OrganizationMenu } from "./organization-menu.tsx";
import { QueuedSidebarRow } from "./queued-session-row.tsx";
import { RenameField, RowContextMenuContent, RowMenuButton } from "./row-actions.tsx";

/**
 * The app's left sidebar on the desk (Doop "App sidebar", "Sidebar group", "Sidebar row"): the
 * organization, search and New session, Projects and Skills, the inbox's filters and its five
 * groups, then Settings and the account. It is the only inbox: every list of a person's sessions
 * lives here, grouped by what they need.
 *
 * It folds to a 48px rail and opens again (`SidebarToggle` in a sheet's header, ⌘B, or the edge
 * of the sidebar); the choice is kept per browser (`sidebarExpanded`). The organization row opens
 * the switcher (`organization-menu.tsx`), the account row the account menu (`account-menu.tsx`),
 * and a session row's menu is `row-actions.tsx`.
 */

/** The sidebar's width on the desk, and its rail's, as the canvas draws them. */
export const SIDEBAR_WIDTH = "264px";
export const SIDEBAR_RAIL_WIDTH = "48px";

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

/**
 * The sidebar's edge as a place to click to fold it: nothing drawn at rest, and while pointed at,
 * a short rounded handle inside the sidebar's gutter, clear of the sheet's edge (not a border).
 */
const RAIL_HANDLE = cn(
  "z-30 after:start-[calc(50%-6px)] after:inset-y-[calc(50%-1.25rem)] after:w-1 after:rounded-full",
  "hover:after:bg-muted-foreground/45",
);

/** How far a press on the edge may travel the other way and still count. */
const EDGE_SLACK_PX = 8;

/**
 * The sidebar's edge (`RAIL_HANDLE`): a press on it folds the sidebar to its rail, or opens the
 * rail again, wherever the pointer is let go. The edge shows a resize cursor, so people drag it as
 * often as they click it; a drag ended off the edge made no click, and the sidebar stayed open
 * (SLNT-1229). A drag the other way, wider while open or narrower while folded, does nothing.
 */
function SidebarEdge() {
  const { state, toggleSidebar } = useSidebar();
  const pressedAt = useRef<number | null>(null);
  return (
    <SidebarRail
      className={RAIL_HANDLE}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // No focus ring left on the edge, and no text selected on the way.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pressedAt.current = event.clientX;
      }}
      onPointerUp={(event) => {
        const from = pressedAt.current;
        pressedAt.current = null;
        if (from === null) return;
        const moved = event.clientX - from;
        const otherWay = state === "expanded" ? moved > EDGE_SLACK_PX : moved < -EDGE_SLACK_PX;
        if (!otherWay) toggleSidebar();
      }}
      onPointerCancel={() => {
        pressedAt.current = null;
      }}
      // A pointer's press has already acted; a click with no pointer (assistive tech) still does.
      onClick={(event) => {
        if (event.detail === 0) toggleSidebar();
      }}
    />
  );
}

/**
 * Room for a focus ring inside a list that scrolls: a scroller clips what is drawn outside its
 * box, and a row's ring is drawn just outside the row. The padding gives the ring that room at
 * the sides and the negative margin keeps the rows where they were; the scroll padding stops the
 * keyboard from scrolling a focused row flush against the top or bottom, where its ring is cut.
 */
export const RING_ROOM = "-mx-1 px-1 scroll-py-1";

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
  account,
  inbox,
  online,
}: {
  readonly organizationName: string;
  readonly account: Account;
  /** The inbox's reads; the sidebar draws their loading, failure and empty states. */
  readonly inbox: InboxState;
  readonly online: boolean;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { state } = useSidebar();
  const macInset = useMacDesktopTitlebarInset();
  const area = areaOf(pathname);
  const openId = openSessionOf(pathname);
  return (
    <Sidebar
      collapsible="icon"
      aria-label="Sidebar"
      // The kit draws a border on a left sidebar's edge; the sheet's own rounded edge is the edge.
      // Inside macOS desktop (`hiddenInset`), reserve top desk room for the traffic lights.
      className={cn(
        "bg-sidebar group-data-[side=left]:border-r-0 pr-2 pb-2.5 pl-3 text-sidebar-foreground tabular-nums group-data-[collapsible=icon]:p-2",
        macInset ? "pt-11 group-data-[collapsible=icon]:pt-11" : "pt-3",
      )}
    >
      {macInset ? (
        <div
          aria-hidden
          className="desktop-drag pointer-events-auto fixed top-0 left-0 z-20 h-10 w-sidebar"
        />
      ) : null}
      {state === "expanded" ? (
        <ExpandedSidebar
          organizationName={organizationName}
          account={account}
          inbox={inbox}
          online={online}
          area={area}
          openId={openId}
        />
      ) : (
        <SidebarRailNav
          organizationName={organizationName}
          account={account}
          inbox={inbox}
          online={online}
          area={area}
          openId={openId}
        />
      )}
      <SidebarEdge />
    </Sidebar>
  );
}

interface SidebarParts {
  readonly organizationName: string;
  readonly account: Account;
  readonly inbox: InboxState;
  readonly online: boolean;
  readonly area: SidebarArea;
  readonly openId: string | undefined;
}

/** The sidebar open in full: the organization, search, the pages, the inbox, then you. */
function ExpandedSidebar({ organizationName, account, inbox, online, area, openId }: SidebarParts) {
  const host = useServerHost();
  return (
    <>
      <SidebarHeader className="gap-0 p-0">
        <OrganizationMenu organizationName={organizationName} place="sidebar" />
        <div className="my-2.5 flex gap-1.5">
          <SearchField />
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
      <SidebarContent className={cn("mt-1 gap-0 pt-1", RING_ROOM)}>
        <SidebarInbox inbox={inbox} online={online} openId={openId} host={host} />
      </SidebarContent>
      <SidebarFooter className="gap-0.5 border-t border-sidebar-border p-0 pt-2">
        <SidebarMenu>
          <NavItem to="settings" icon={<SettingsIcon />} active={area === "settings"}>
            Settings
          </NavItem>
        </SidebarMenu>
        <AccountMenu account={account} place="sidebar" />
      </SidebarFooter>
    </>
  );
}

/**
 * The sidebar folded to its 48px rail (Doop "App sidebar", state=collapsed): the organization's
 * mark, New session, the inbox as a flyout with the count waiting on you, Projects and Skills,
 * then one glyph per session the full sidebar lists in its open groups, Settings and you. Each
 * control names itself in a tooltip.
 */
function SidebarRailNav({ organizationName, account, inbox, online, area, openId }: SidebarParts) {
  const folds = inboxFolds.use();
  const view = inbox.status === "success" ? inbox.view : undefined;
  const sessions = view === undefined ? [] : railRows(view.groups, folds, openId);
  const waiting = view?.groups.waiting.length ?? 0;
  return (
    <TooltipProvider>
      <nav aria-label="Sidebar rail" className="flex min-h-0 flex-1 flex-col items-center">
        <OrganizationMenu organizationName={organizationName} place="rail" />
        <SidebarMenu className="mt-2 w-auto gap-0.5">
          <RailSearch />
          <RailItem label="New session" active={false} className={RAISED} render={<Link to="/" />}>
            <SquarePenIcon />
          </RailItem>
        </SidebarMenu>
        <SidebarMenu className="mt-2.5 w-auto gap-0.5">
          <InboxFlyout inbox={inbox} online={online} openId={openId} waiting={waiting} />
          <RailItem label="Projects" active={area === "projects"} render={<Link to="/projects" />}>
            <FolderIcon />
          </RailItem>
          <RailItem label="Skills" active={area === "skills"} render={<Link to="/skills" />}>
            <SparklesIcon />
          </RailItem>
        </SidebarMenu>
        <span aria-hidden className="my-3.5 h-px w-4 shrink-0 bg-sidebar-border" />
        <SidebarMenu
          aria-label="Sessions"
          className={cn(
            "min-h-0 w-auto flex-1 content-start gap-0.5 overflow-y-auto",
            RING_ROOM,
            "-my-1 py-1",
          )}
        >
          {sessions.map((row) => (
            <RailSession
              key={row.session.id}
              row={row}
              now={view?.now ?? new Date()}
              active={row.session.id === openId}
            />
          ))}
        </SidebarMenu>
        <div className="grid w-8 shrink-0 justify-items-center gap-1 border-t border-sidebar-border pt-2">
          <SidebarMenu className="w-auto">
            <RailItem
              label="Settings"
              active={area === "settings"}
              render={<Link to="/settings" />}
            >
              <SettingsIcon />
            </RailItem>
          </SidebarMenu>
          <AccountMenu account={account} place="rail" />
        </div>
      </nav>
    </TooltipProvider>
  );
}

const railButton = cn(
  "grid size-8 place-items-center rounded-lg p-0 text-foreground",
  HOVER,
  "data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground [&_svg]:size-4",
);

/** One control on the rail: a 32px button with its name in a tooltip. */
function RailItem({
  label,
  active,
  render,
  className,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly render: ReactElement;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={label}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(railButton, className)}
        render={render}
      >
        {children}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** One session on the rail (Doop "Sidebar rail session"): its glyph, its title in a tooltip. */
function RailSession({
  row,
  now,
  active,
}: {
  readonly row: InboxRow;
  readonly now: Date;
  readonly active: boolean;
}) {
  const status = rowStatus(row, now);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={row.title}
        aria-label={`${row.title}, ${status.word}`}
        className={cn(railButton, "text-muted-foreground")}
        render={
          <Link
            {...sessionLink(row.session.id)}
            data-session-id={row.session.id}
            aria-current={active ? "page" : undefined}
          />
        }
      >
        {/* The same glyph as the row's: its shape the group, its colour the pull request. */}
        <Changed value={rowLump(row)}>
          <Lump status={rowLump(row)} pr={rowPr(row)} className="size-4" />
        </Changed>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The inbox from the rail (Doop "Collapsed sidebar · inbox flyout"): the same filters and groups
 * as the full sidebar, in a panel the height of the window beside the rail. Opening a session
 * closes it.
 */
function InboxFlyout({
  inbox,
  online,
  openId,
  waiting,
}: {
  readonly inbox: InboxState;
  readonly online: boolean;
  readonly openId: string | undefined;
  readonly waiting: number;
}) {
  const [open, setOpen] = useState(false);
  const host = useServerHost();
  const rail = useRef<HTMLElement | null>(null);
  const label = waiting === 0 ? "Inbox" : `Inbox, ${waiting} waiting on you`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SidebarMenuItem
        ref={(item) => {
          // The panel lines up with the rail, not with the button that opens it.
          rail.current = item?.closest<HTMLElement>("[data-slot=sidebar-container]") ?? null;
        }}
      >
        <SidebarMenuButton
          isActive={open}
          tooltip="Inbox"
          aria-label={label}
          className={railButton}
          render={<PopoverTrigger />}
        >
          <InboxIcon />
          {waiting === 0 ? null : (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 text-2xs leading-none font-semibold text-background shadow-[0_0_0_2px_var(--color-sidebar)]"
            >
              {waiting}
            </span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
      <PopoverContent
        anchor={rail}
        side="right"
        align="start"
        sideOffset={2}
        alignOffset={8}
        aria-label="Inbox"
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a") !== null) setOpen(false);
        }}
        className="h-[calc(100dvh-1rem)] w-79 gap-0 overflow-hidden p-0 tabular-nums"
      >
        <div className="flex items-center gap-2 border-b border-border py-2.5 pr-2 pl-4">
          <PopoverTitle className="text-lead font-semibold">Inbox</PopoverTitle>
          {inbox.status === "success" ? <InboxFilterMenu filters={inbox.view.filters} /> : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 pt-1.5">
          <SidebarInbox inbox={inbox} online={online} openId={openId} host={host} filters={false} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The sidebar's Search field: it opens the command palette, as ⌘K does. */
function SearchField() {
  const openSearch = useOpenSearch();
  const keys = useKeys("K");
  return (
    <button
      type="button"
      onClick={openSearch}
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 text-muted-foreground outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50",
        RAISED,
      )}
    >
      <SearchIcon aria-hidden className="size-4" />
      <span className="flex-1 text-left text-row">Search</span>
      <kbd aria-hidden className="font-sans text-2xs font-medium">
        {keys}
      </kbd>
    </button>
  );
}

/** Search on the rail: the same palette, its name and shortcut in a tooltip. */
function RailSearch() {
  const openSearch = useOpenSearch();
  const keys = useKeys("K");
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={{
          children: (
            <>
              Search <Kbd>{keys}</Kbd>
            </>
          ),
        }}
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        className={railButton}
        onClick={openSearch}
      >
        <SearchIcon aria-hidden />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The button in a sheet's header that folds the sidebar to its rail, or opens it again (⌘B). */
export function SidebarToggle() {
  const { state, toggleSidebar } = useSidebar();
  const label = state === "expanded" ? "Collapse sidebar" : "Expand sidebar";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-expanded={state === "expanded"}
            onClick={toggleSidebar}
            className="text-muted-foreground"
          />
        }
      >
        <PanelLeftIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label} <Kbd>⌘B</Kbd>
      </TooltipContent>
    </Tooltip>
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
        render={<Link to={`/${to}`} aria-current={active ? "page" : undefined} />}
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
  filters = true,
}: {
  readonly inbox: InboxState;
  readonly online: boolean;
  readonly openId: string | undefined;
  readonly host: string;
  /** The filter line above the groups; the rail's flyout has it in its header instead. */
  readonly filters?: boolean;
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
      return <InboxGroups view={inbox.view} online={online} openId={openId} filters={filters} />;
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
  filters,
}: {
  readonly view: InboxView;
  readonly online: boolean;
  readonly openId: string | undefined;
  readonly filters: boolean;
}) {
  const folds = inboxFolds.use();
  // Rows change group in place, then slide; the moves hold where each is listed meanwhile.
  const moving = useSidebarMoves(view.groups, folds);
  return (
    <>
      {filters ? (
        <div className="mb-1.5 px-0.5">
          <InboxFilterMenu filters={view.filters} />
        </div>
      ) : null}
      {online ? null : <OfflineBand view={view} layout="stacked" onRetry={view.refresh} />}
      <nav
        aria-label="Inbox"
        className={cn("min-h-0 flex-1 overflow-y-auto pt-1.5 pb-2", RING_ROOM)}
      >
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
              rows={moving.groups[group]}
              queued={queuedIn(view, group)}
              open={folds[group]}
              lit={moving.litGroups.has(group)}
              onOpenChange={(open) => inboxFolds.set({ ...folds, [group]: open })}
              all={view.all}
              now={view.now}
              openId={openId}
              viewerId={view.viewerId}
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
  lit,
  onOpenChange,
  all,
  now,
  openId,
  viewerId,
}: {
  readonly group: InboxGroup;
  readonly label: string;
  /** Its rows as they move: rows on their way out and the closing places rows left included. */
  readonly rows: ReadonlyArray<ShownRow>;
  readonly queued: ReadonlyArray<QueuedRow>;
  readonly open: boolean;
  /** A row just landed in it while it was folded: its heading lights instead. */
  readonly lit: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly all: ReadonlyArray<InboxRow>;
  readonly now: Date;
  readonly openId: string | undefined;
  readonly viewerId: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const listed = rows.filter((entry) => entry.phase !== "leaving");
  // The open session stays listed, wherever it falls in its group.
  const kept = new Set(
    shownRows(
      listed.map((entry) => entry.row),
      openId,
      showAll,
    ).map((row) => row.session.id),
  );
  const shown = rows.filter((entry) => entry.phase === "leaving" || kept.has(entry.row.session.id));
  const more = listed.length - kept.size;
  const wait = group === "waiting" && listed.length > 0;
  // Folded, the group still shows the open session's row, alone under its heading.
  const openRow = open ? undefined : listed.find((entry) => entry.row.session.id === openId);
  const item = (entry: ShownRow) => (
    <InboxRowItem
      key={entry.phase === "leaving" ? `${entry.row.session.id}:left` : entry.row.session.id}
      row={entry.row}
      phase={entry.phase}
      lit={entry.lit}
      shared={sharedWith(entry.row, all)}
      now={now}
      active={entry.row.session.id === openId}
      viewerId={viewerId}
    />
  );
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
            lit && "animate-row-lit",
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
            {listed.length + queued.length}
          </span>
        </CollapsibleTrigger>
        {openRow === undefined ? null : <SidebarMenu>{item(openRow)}</SidebarMenu>}
        <CollapsibleContent>
          <SidebarGroupContent>
            {queued.length === 0 ? null : (
              <SidebarMenu>
                {queued.map((row) => (
                  <QueuedSidebarRow key={row.id} row={row} now={now} />
                ))}
              </SidebarMenu>
            )}
            {shown.length === 0 && queued.length === 0 ? (
              <p className="py-2.5 pr-2 pl-4 text-row text-muted-foreground">
                {EMPTY_GROUP[group]}
              </p>
            ) : shown.length === 0 ? null : (
              <SidebarMenu>{shown.map(item)}</SidebarMenu>
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
  phase,
  lit,
  shared,
  now,
  active,
  viewerId,
}: {
  readonly row: InboxRow;
  readonly phase: ShownRow["phase"];
  readonly lit: boolean;
  readonly shared: number | null;
  readonly now: Date;
  readonly active: boolean;
  readonly viewerId: string | null;
}) {
  const status = rowStatus(row, now);
  const handlers = useRowActions();
  const actions = rowActions(row, viewerId);
  const [renaming, setRenaming] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const startRename = () => {
    if (actions.rename) setRenaming(true);
  };
  // Back on the row once the box closes, so the keyboard carries on from where it was.
  const endRename = () => {
    flushSync(() => setRenaming(false));
    link.current?.focus();
  };
  const menu = { row, actions, handlers, onRename: startRename };
  // A start still on its way to Mend: nothing on the server to act on yet (SLNT-1196).
  const starting = isPendingRow(row);
  const leaving = phase === "leaving";
  return (
    <SidebarRow
      link={link}
      lump={{ status: rowLump(row), pr: rowPr(row) }}
      phase={phase}
      lit={lit}
      renaming={
        renaming ? (
          <RenameField
            title={row.title}
            onSave={(text) => {
              handlers.rename(row, text);
              endRename();
            }}
            onCancel={endRename}
          />
        ) : undefined
      }
      onRenameKey={actions.rename && !starting ? startRename : undefined}
      // The place a row left, closing, is a picture of it with nothing to press; so is a start
      // still on its way to Mend.
      contextMenu={starting || leaving ? undefined : <RowContextMenuContent {...menu} />}
      actions={starting || leaving ? undefined : <RowMenuButton {...menu} />}
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
      active={active && !leaving}
    />
  );
});

/**
 * One session in the inbox (Doop "Sidebar row"): its title, then one muted line of project, what
 * it is doing or how it ended, and how long ago, and an optional note line (the workspace it
 * shares). Only "Failed" is red. The row opens the session; `actions` is its "…" (shown on hover,
 * focus, and while its menu is open), `contextMenu` the menu a right-click opens, and `renaming`
 * takes the row's place while its title is edited.
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
  contextMenu,
  renaming,
  onRenameKey,
  link,
  lump,
  phase = "still",
  lit = false,
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
  readonly contextMenu?: ReactNode;
  readonly renaming?: ReactNode | undefined;
  /** F2 on the row starts renaming it. */
  readonly onRenameKey?: (() => void) | undefined;
  readonly link?: Ref<HTMLAnchorElement>;
  /** The session glyph (`sheet-lump`): its shape the session's state, its colour the pull request. */
  readonly lump?: { readonly status: LumpStatus; readonly pr: LumpPr };
  /** Moving: `entering` opens its new place, `leaving` closes the old (`lib/sidebar-moves.ts`). */
  readonly phase?: ShownRow["phase"];
  /** Just landed here: lit while the fill fades. */
  readonly lit?: boolean;
}) {
  const parts = [
    { key: "project", text: project, className: "" },
    { key: "status", text: status, className: failed ? "text-destructive" : "" },
    { key: "age", text: ago, className: "" },
  ].filter((part) => part.text !== "");
  const leaving = phase === "leaving";
  const body = (
    <>
      <SidebarMenuButton
        isActive={active}
        className={cn(
          "relative block h-auto rounded-lg pt-1.5 pr-2 pb-1.75 pl-6 leading-snug font-normal",
          HOVER,
          "data-active:bg-sidebar-accent",
          // Its menu is open: a ring round the row it acts on.
          "group-data-popup-open/row:ring-1 group-data-popup-open/row:ring-ring group-has-data-popup-open/row:ring-1 group-has-data-popup-open/row:ring-ring",
          actions === undefined
            ? ""
            : "group-hover/row:pr-9 group-focus-within/row:pr-9 group-has-data-popup-open/row:pr-9",
          renaming === undefined ? "" : "hidden",
        )}
        render={
          <Link
            {...sessionLink(sessionId)}
            ref={link}
            data-session-id={leaving ? undefined : sessionId}
            tabIndex={leaving ? -1 : undefined}
            aria-current={active ? "page" : undefined}
            onKeyDown={(event) => {
              if (event.key === "F2" && onRenameKey !== undefined) {
                event.preventDefault();
                onRenameKey();
              }
            }}
          />
        }
      >
        {lump === undefined ? null : (
          <Changed value={lump.status} className="absolute top-2.25 left-1.5">
            <Lump status={lump.status} pr={lump.pr} className="size-3.5" />
          </Changed>
        )}
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
              {part.key === "status" ? (
                <Changed value={part.text} className={part.className}>
                  {part.text}
                </Changed>
              ) : (
                <span className={part.className}>{part.text}</span>
              )}
            </Fragment>
          ))}
        </span>
        {note === undefined ? null : (
          <span className="mt-px block truncate text-meta text-muted-foreground">{note}</span>
        )}
      </SidebarMenuButton>
      {renaming}
      {actions === undefined || renaming !== undefined ? null : (
        <span className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 group-focus-within/row:flex group-hover/row:flex group-has-data-popup-open/row:flex">
          {actions}
        </span>
      )}
    </>
  );
  // Moving, the row's height runs from nothing to its own (or back); the fill fades once it lands.
  const itemClass = cn(
    "group/row grid rounded-lg",
    phase === "entering" && "animate-row-open",
    leaving && "pointer-events-none animate-row-close",
    lit && "animate-row-lit",
  );
  // `min-w-0`: a grid item is as wide as its longest line otherwise, so a long row runs past the
  // sidebar instead of truncating, and its focus ring is cut.
  const content = (
    <div className={cn("relative min-h-0 min-w-0", phase !== "still" && "overflow-hidden")}>
      {body}
    </div>
  );
  if (contextMenu === undefined || renaming !== undefined)
    return (
      <SidebarMenuItem
        className={itemClass}
        data-row-id={leaving ? undefined : sessionId}
        aria-hidden={leaving ? true : undefined}
        inert={leaving}
      >
        {content}
      </SidebarMenuItem>
    );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <SidebarMenuItem className={cn(itemClass, "select-auto")} data-row-id={sessionId} />
        }
      >
        {content}
      </ContextMenuTrigger>
      {contextMenu}
    </ContextMenu>
  );
}
