import { Banner } from "@mend/ui/components/banner";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mend/ui/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  InboxIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { adoptionProgressOptions, clonePercent, useAdoptionAttempt } from "#/lib/adoptions";
import {
  activity,
  activityDetail,
  age,
  askDetail,
  EMPTY_GROUP,
  GROUP_ROWS,
  INBOX_GROUPS,
  type InboxGroup,
  type InboxRow,
  type QueuedRow,
  rowStatus,
} from "#/lib/inbox";
import { useServerHost } from "#/lib/online";
import { isPendingRow } from "#/lib/pending-starts";
import { rowActions } from "#/lib/row-actions";
import { useSeenAfterIdle } from "#/lib/seen";
import { askersDetail } from "#/lib/shared-control";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { inboxFolds } from "#/lib/ui-prefs";
import type { InboxState, InboxView } from "#/lib/use-inbox";
import { useRowActions } from "#/lib/use-row-actions";

import { OfflineBand, queuedIn } from "./app-sidebar.tsx";
import { useOpenSearch } from "./command-palette.tsx";
import { filterWords, InboxFilterSheet } from "./inbox-filters.tsx";
import { QueuedPhoneRow } from "./queued-session-row.tsx";
import { PhoneRowActions } from "./row-actions.tsx";
import { SessionRow } from "./session-row.tsx";

/**
 * The inbox as its own screen on a phone (under 1024px): the "Inbox" header with search and New
 * session, the filter row, the five groups as 44px headings over touch rows, and the tab bar. The
 * same reads, filters and folds as the sidebar. Approving from a row is the phone app's alone: a
 * row here opens the session.
 */
export function PhoneInbox({
  organizationName,
  inbox,
  online,
  className,
}: {
  readonly organizationName: string;
  readonly inbox: InboxState;
  readonly online: boolean;
  readonly className?: string;
}) {
  const host = useServerHost();
  const openSearch = useOpenSearch();
  // The filter row scrolls away under the header; the header then names the filters itself.
  const filterRow = useRef<HTMLDivElement>(null);
  const filtersInView = useInView(filterRow);
  const view = inbox.status === "success" ? inbox.view : undefined;
  const words = view === undefined ? undefined : filterWords(view.filters, projectNameOf(view));
  const waiting = view?.groups.waiting.length ?? 0;
  return (
    <div className={cn("flex min-h-dvh flex-col bg-background pb-14", className)}>
      <header className="sticky top-0 z-10 flex items-center gap-1 bg-background pt-3 pr-1 pb-1 pl-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="truncate text-2xs text-muted-foreground">
            {filtersInView || words === undefined
              ? organizationName
              : `${organizationName} · ${words.project} · ${words.whose}`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Search"
          onClick={openSearch}
        >
          <SearchIcon aria-hidden className="size-5.5" />
        </Button>
        <Link
          to="/new"
          aria-label="New session"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-touch" }),
            !online && "text-muted-foreground",
          )}
        >
          <SquarePenIcon aria-hidden className="size-5.5" />
        </Link>
      </header>
      {online || view === undefined ? null : (
        <OfflineBand view={view} layout="stacked" onRetry={view.refresh} />
      )}
      <div ref={filterRow}>
        {view === undefined ? null : <InboxFilterSheet filters={view.filters} />}
      </div>
      <CloneBand />
      <PhoneInboxBody inbox={inbox} host={host} organizationName={organizationName} />
      <PhoneTabBar active="inbox" badge={waiting} />
    </div>
  );
}

/**
 * While a clone this browser started runs (frame "Phone · First run · clone still running"): a
 * session can be started in its project now, and waits for it. Nothing while the clone's progress
 * is read, once it ended, or when the read failed.
 */
function CloneBand() {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const attempt = useAdoptionAttempt(viewer.userId);
  const progress = useQuery({
    ...adoptionProgressOptions(trpc, attempt?.id ?? ""),
    enabled: attempt !== null,
  });
  if (attempt === null || progress.isPending || progress.isError) return null;
  if (progress.data === null || progress.data.state !== "running") return null;
  const percent = clonePercent(progress.data);
  return (
    <Banner
      tone="info"
      layout="stacked"
      title={`${attempt.name} is still cloning${percent === null ? "" : ` (${percent}%)`}.`}
    >
      You can start a session now. It starts when the clone finishes.
    </Banner>
  );
}

const projectNameOf = (view: InboxView): string | undefined =>
  view.filters.projectId === null
    ? undefined
    : view.all.find((row) => row.project.id === view.filters.projectId)?.project.name;

/** Whether `box` is on screen; true until the browser says otherwise. */
const useInView = (box: React.RefObject<HTMLElement | null>): boolean => {
  const [inView, setInView] = useState(true);
  // Watching the screen needs the mounted element and the browser: an effect.
  useEffect(() => {
    const element = box.current;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      // Under the sticky header, not under the top of the window.
      { rootMargin: "-72px 0px 0px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return inView;
};

function PhoneInboxBody({
  inbox,
  host,
  organizationName,
}: {
  readonly inbox: InboxState;
  readonly host: string;
  readonly organizationName: string;
}) {
  switch (inbox.status) {
    case "pending":
      return (
        <p role="status" className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
          {host === "" ? "Loading your sessions…" : `Loading your sessions from ${host}…`}
        </p>
      );
    case "error":
      return (
        <div role="alert" className="flex flex-col items-start gap-3 px-4 py-4 text-sm">
          <p>
            <span className="font-medium">Your sessions didn't load.</span>{" "}
            <span className="text-muted-foreground">
              {inbox.error instanceof Error && inbox.error.message !== ""
                ? inbox.error.message
                : "Something went wrong."}
            </span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={inbox.retrying}
            onClick={inbox.retry}
          >
            {inbox.retrying ? "Trying again…" : "Try again"}
          </Button>
        </div>
      );
    case "success":
      return inbox.view.empty ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>
              Start a session to give an agent a task in one of {organizationName}'s projects. Your
              sessions show here, grouped by what they need from you.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to="/new" className={buttonVariants({ size: "touch" })}>
              New session
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <PhoneGroups view={inbox.view} />
      );
  }
}

function PhoneGroups({ view }: { readonly view: InboxView }) {
  const folds = inboxFolds.use();
  return (
    <nav aria-label="Inbox" className="mt-1">
      {INBOX_GROUPS.map(({ group, label }) => (
        <PhoneGroup
          key={group}
          group={group}
          label={label}
          rows={view.groups[group]}
          queued={queuedIn(view, group)}
          open={folds[group]}
          onOpenChange={(open) => inboxFolds.set({ ...folds, [group]: open })}
          now={view.now}
          viewerId={view.viewerId}
        />
      ))}
    </nav>
  );
}

/** One group (Doop "Phone inbox group"): a 44px heading with a hairline, then its touch rows. */
function PhoneGroup({
  group,
  label,
  rows,
  queued,
  open,
  onOpenChange,
  now,
  viewerId,
}: {
  readonly group: InboxGroup;
  readonly label: string;
  readonly rows: ReadonlyArray<InboxRow>;
  readonly queued: ReadonlyArray<QueuedRow>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly now: Date;
  readonly viewerId: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, GROUP_ROWS);
  const more = rows.length - shown.length;
  const wait = group === "waiting" && rows.length > 0;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} render={<section aria-label={label} />}>
      <CollapsibleTrigger
        className={cn(
          "flex h-11 w-full items-center gap-2 border-t border-b border-border pr-4 pl-3.5 text-left text-sm font-semibold outline-none first:border-t-0 focus-visible:bg-muted",
          wait ? "text-warning" : "text-foreground",
        )}
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          className={cn(
            "text-control font-medium",
            wait ? "text-warning" : "text-muted-foreground",
          )}
        >
          {rows.length + queued.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {queued.length === 0 ? null : (
          <ul>
            {queued.map((row) => (
              <QueuedPhoneRow key={row.id} row={row} now={now} />
            ))}
          </ul>
        )}
        {rows.length === 0 && queued.length === 0 ? (
          <p className="border-b border-border px-4 pt-2.5 pb-3 text-sm text-muted-foreground">
            {group === "waiting"
              ? "Nothing is waiting on you. When an agent asks a question or wants approval, the session shows here."
              : EMPTY_GROUP[group]}
          </p>
        ) : rows.length === 0 ? null : (
          <ul>
            {shown.map((row) => (
              <PhoneRow key={row.session.id} row={row} now={now} viewerId={viewerId} />
            ))}
          </ul>
        )}
        {more > 0 ? (
          <div className="border-b border-border px-4">
            <Button
              type="button"
              variant="link"
              className="h-11 text-sm"
              onClick={() => setShowAll(true)}
            >
              Show {more} more
            </Button>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PhoneRow({
  row,
  now,
  viewerId,
}: {
  readonly row: InboxRow;
  readonly now: Date;
  readonly viewerId: string;
}) {
  const status = rowStatus(row, now);
  const handlers = useRowActions();
  const changeId = row.annotation?.changeId ?? null;
  let last: ReactNode = status.word;
  if (row.group === "waiting")
    last =
      row.session.status !== "waiting" && row.askers.length > 0
        ? askersDetail(row.askers)
        : askDetail(row.ask);
  else if (row.activity !== null) last = activityDetail(row.activity);
  else if (status.failed && row.failure !== null) last = `${status.word} · ${row.failure}`;
  else if (row.group === "review" && changeId !== null && !status.failed)
    last = (
      <>
        {status.word}
        <DiffStats changeId={changeId} />
      </>
    );
  return (
    <SessionRow
      sessionId={row.session.id}
      title={row.title}
      project={row.project.name}
      last={last}
      bad={status.failed}
      when={row.group === "snoozed" ? "" : age(new Date(activity(row)), now)}
      actions={
        // A start still on its way to Mend has nothing on the server to act on yet.
        isPendingRow(row) ? undefined : (
          <PhoneRowActions row={row} actions={rowActions(row, viewerId)} handlers={handlers} />
        )
      }
    />
  );
}

/**
 * " · +62 −9 in 5 files" after a change to review: read once the row is on screen and the page has
 * settled (`useSeenAfterIdle`), never for the whole list on first paint. Nothing while it reads or
 * when it can't be read: the row still says how the session ended.
 */
function DiffStats({ changeId }: { readonly changeId: string }) {
  const trpc = useTRPC();
  const box = useRef<HTMLSpanElement>(null);
  const seen = useSeenAfterIdle(box);
  const stats = useQuery(
    trpc.changes.stats.queryOptions({ id: changeId }, { staleTime: 60_000, enabled: seen }),
  );
  if (stats.isPending || stats.isError) return <span ref={box} />;
  const { files, additions, deletions } = stats.data;
  return (
    <span ref={box}>
      {files === 0
        ? " · No file changes"
        : ` · +${additions} −${deletions} in ${files} ${files === 1 ? "file" : "files"}`}
    </span>
  );
}

/** The phone's bottom navigation (Doop "Phone tab bar"): Inbox, Projects, Skills, Settings. */
export function PhoneTabBar({
  active,
  badge,
}: {
  readonly active: "inbox" | "projects" | "skills" | "settings";
  /** The Waiting on you count on Inbox; 0 shows none. */
  readonly badge: number;
}) {
  const tabs = [
    { key: "inbox", link: { to: "/" }, label: "Inbox", icon: <InboxIcon /> },
    { key: "projects", link: { to: "/projects" }, label: "Projects", icon: <FolderIcon /> },
    { key: "skills", link: { to: "/skills" }, label: "Skills", icon: <SparklesIcon /> },
    { key: "settings", link: { to: "/settings" }, label: "Settings", icon: <SettingsIcon /> },
  ] as const;
  return (
    <nav
      aria-label="Tabs"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid h-14 grid-cols-4">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            {...tab.link}
            aria-current={tab.key === active ? "page" : undefined}
            aria-label={
              tab.key === "inbox" && badge > 0 ? `${tab.label}, ${badge} waiting on you` : undefined
            }
            className={cn(
              "flex flex-col items-center justify-center gap-0.75 text-2xs font-medium outline-none focus-visible:bg-muted [&_svg]:size-5.5",
              tab.key === active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="relative">
              {tab.icon}
              {tab.key === "inbox" && badge > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1.25 left-3.5 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-warning px-1.25 text-2xs font-semibold text-background"
                >
                  {badge}
                </span>
              ) : null}
            </span>
            {tab.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
