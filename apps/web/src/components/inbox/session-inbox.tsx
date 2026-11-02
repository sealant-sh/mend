import { Collapsible } from "@base-ui/react/collapsible";
import { useContextMenu } from "@mend/ui/context-menu";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { Button, Eyebrow, focusRing, IconButton } from "#/components/kit/button";
import { Icon } from "#/components/kit/icons";
import { Menu, MenuItem, MenuMeta } from "#/components/kit/menu";
import { StatusWord } from "#/components/kit/status";
import { PROMPT_ID } from "#/components/session-composer";
import {
  groupRows,
  inboxRows,
  matchesFilters,
  OPEN_PLACES,
  rowStatus,
  snoozeChoices,
  sourcesOfInbox,
  whenAhead,
  type InboxRow,
} from "#/lib/inbox";
import { inboxQuery } from "#/lib/inbox-live";
import {
  useInboxMarks,
  useMarkFailures,
  useMarksInFlight,
  useSetInboxMark,
  type MarkChange,
} from "#/lib/inbox-marks";
import { useTRPC } from "#/lib/trpc";
import { inboxFilters } from "#/lib/ui-prefs";
import { useViewer } from "#/lib/viewer";
import { sessionMenu } from "#/lib/workbench-menus";

import { InboxFilterLine } from "./filter-line";

const SETTLED_PAGE = 50;

const subscribeToMinutes = (onChange: () => void) => {
  const timer = setInterval(onChange, 15_000);
  return () => clearInterval(timer);
};
const minuteNow = () => Math.floor(Date.now() / 60_000);

/** The current minute; re-renders only when it turns, so "running · 6 min" stays true. */
const useMinute = () => {
  const minute = useSyncExternalStore(subscribeToMinutes, minuteNow, minuteNow);
  // One Date per minute, so the memoized rows keep their props between minutes.
  return useMemo(() => new Date(minute * 60_000), [minute]);
};

/**
 * The Sessions inbox (screens S1 to S3): every session this person can see, grouped by what it
 * needs, with Snoozed and Settled folded at the bottom. Hovering or focusing a row shows Snooze
 * and Settle. Live through the shell's event stream: a session that starts waiting moves into
 * Needs you without a reload. `selectedId` marks the open session.
 */
export function SessionInbox({
  selectedId,
  onReadAhead,
}: {
  readonly selectedId: string | undefined;
  /** Told each session read ahead, once its header and first page are in the cache. */
  readonly onReadAhead?: (sessionId: string) => void;
}) {
  const trpc = useTRPC();
  // "Mine" compares against the signed-in account itself, which is what a session's owner records:
  // the organization read the layout's loader warmed, so the server renders the same rows.
  const me = useViewer()?.userId ?? null;
  const filters = inboxFilters.use();
  const now = useMinute();
  // One read for every row, live through the shell's event stream (`patchInbox`); the project
  // list only names the filter line's projects.
  const inbox = useQuery(inboxQuery(trpc));
  const projects = useQuery(trpc.projects.list.queryOptions());
  const marks = useInboxMarks();
  // One mutation owner above the rows: a row that moves group unmounts, its mark keeps going.
  const setMark = useSetInboxMark();
  const saving = useMarksInFlight();
  const { failures, dismiss } = useMarkFailures();
  const { mutate } = setMark;
  const onMark = useCallback((id: string, mark: MarkChange) => mutate({ id, mark }), [mutate]);

  const loading = inbox.isPending || marks.isPending;
  // The rows keep their identity while their reads do: opening a session re-renders the two rows
  // whose selection changed (`InboxItem` is memoized), never the whole list.
  const rows = useMemo(
    () => inboxRows({ sources: sourcesOfInbox(inbox.data ?? []), marks: marks.data ?? [], now }),
    [inbox.data, marks.data, now],
  );
  const visible = useMemo(
    () => rows.filter((row) => matchesFilters(row, filters, me)),
    [rows, filters, me],
  );
  const groups = useMemo(() => groupRows(visible), [visible]);
  const openCount = groups["needs-you"].length + groups.running.length + groups.review.length;
  const list = usePreloadVisibleRows(rows, onReadAhead);

  return (
    <aside
      ref={list}
      aria-label="Sessions"
      className="sticky top-0 flex h-screen w-[284px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-rule px-3 py-[18px]"
    >
      <div className="flex items-center gap-2 px-1.5 pb-3">
        <h2 className="font-sans text-[15px] font-semibold">Sessions</h2>
        <span className="flex-1" />
        <NewSessionButton />
      </div>
      <InboxFilterLine
        filters={filters}
        projects={projects.data ?? []}
        rows={rows}
        viewerKnown={me !== null}
      />
      <MarkFailure
        failure={failures.at(-1)}
        more={failures.length - 1}
        titleOf={(id) => rows.find((row) => row.session.id === id)?.title ?? "a session"}
        onDismiss={() => {
          for (const failure of failures) dismiss(failure.id);
        }}
      />
      {inbox.isError || marks.isError ? (
        <InboxNote>
          <span role="alert" className="text-danger">
            Sessions did not load.
          </span>{" "}
          <button
            type="button"
            className={cn("text-info underline-offset-2 hover:underline", focusRing)}
            onClick={() => {
              void inbox.refetch();
              void marks.refetch();
            }}
          >
            Try again
          </button>
        </InboxNote>
      ) : loading ? (
        <InboxNote>
          <span role="status">Reading sessions…</span>
        </InboxNote>
      ) : rows.length === 0 ? (
        <InboxNote>No sessions yet. Describe a change to start one.</InboxNote>
      ) : openCount === 0 ? (
        <InboxNote>
          {visible.length === 0 ? (
            <>
              No sessions match these filters.{" "}
              <button
                type="button"
                className={cn("text-info underline-offset-2 hover:underline", focusRing)}
                onClick={() =>
                  inboxFilters.set({
                    projectIds: [],
                    startedBy: "anyone",
                    agent: null,
                    branch: null,
                  })
                }
              >
                Show every session
              </button>
            </>
          ) : (
            "Nothing needs you, runs, or waits for review."
          )}
        </InboxNote>
      ) : (
        OPEN_PLACES.map(({ place, label }) =>
          groups[place].length === 0 ? null : (
            <section key={place} aria-label={label}>
              <Eyebrow className="flex px-2.5 pt-3.5 pb-1">{label}</Eyebrow>
              <ul className="flex flex-col gap-0.5">
                {groups[place].map((row) => (
                  <InboxItem
                    key={row.session.id}
                    row={row}
                    now={now}
                    selected={row.session.id === selectedId}
                    saving={saving.has(row.session.id)}
                    onMark={onMark}
                  />
                ))}
              </ul>
            </section>
          ),
        )
      )}
      <div className="mt-auto pt-3">
        <Fold
          label="Snoozed"
          rows={groups.snoozed}
          now={now}
          selectedId={selectedId}
          saving={saving}
          onMark={onMark}
          first
        />
        <Fold
          label="Settled"
          rows={groups.settled}
          now={now}
          selectedId={selectedId}
          saving={saving}
          onMark={onMark}
        />
      </div>
    </aside>
  );
}

/** How many rows on screen are read ahead: about a phone screen's worth. */
const PRELOADED_ROWS = 12;

/** After the page settles: Safari has no `requestIdleCallback`, so there a timer stands in. */
const whenIdle = (run: () => void): (() => void) => {
  if ("requestIdleCallback" in window) {
    const handle = window.requestIdleCallback(run, { timeout: 3_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, 1_500);
  return () => clearTimeout(timer);
};

/**
 * Read ahead the sessions whose rows are on screen, once the inbox has painted and the browser is
 * idle, and again as more come into view: `preloadRoute` runs the session route's loader (the
 * header and the conversation's first page, under the options the page reads) and fetches its
 * code, so a tap on any row in view is a cache hit. Each session is read ahead once; hover and
 * touch read a row's session the same way, through the link's `intent`. Returns the list's ref.
 */
function usePreloadVisibleRows(
  rows: ReadonlyArray<InboxRow>,
  onReadAhead: ((sessionId: string) => void) | undefined,
) {
  const router = useRouter();
  const [list, setList] = useState<HTMLElement | null>(null);
  const [read] = useState(() => new Set<string>());
  const rowKey = rows.map((row) => row.session.id).join(",");
  // Watching which rows are in view needs the mounted list and the browser: an effect, which
  // runs again when rows come or go.
  useEffect(() => {
    if (list === null || rowKey === "" || typeof IntersectionObserver === "undefined") return;
    const due = new Set<string>();
    let cancel: (() => void) | null = null;
    const flush = () => {
      cancel = null;
      for (const sessionId of [...due].slice(0, PRELOADED_ROWS)) {
        due.delete(sessionId);
        read.add(sessionId);
        void router.preloadRoute({ to: "/sessions/$sessionId", params: { sessionId } }).then(
          () => onReadAhead?.(sessionId),
          () => undefined,
        );
      }
      if (due.size > 0) cancel = whenIdle(flush);
    };
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sessionId =
            entry.target instanceof HTMLElement ? entry.target.dataset["sessionId"] : undefined;
          if (entry.isIntersecting && sessionId !== undefined && !read.has(sessionId))
            due.add(sessionId);
        }
        if (due.size > 0 && cancel === null) cancel = whenIdle(flush);
      },
      { root: list },
    );
    for (const link of list.querySelectorAll<HTMLElement>("a[data-session-id]")) seen.observe(link);
    return () => {
      seen.disconnect();
      cancel?.();
    };
  }, [list, rowKey, router, read, onReadAhead]);
  return setList;
}

const VERB: Record<MarkChange["_tag"], string> = {
  Snoozed: "snooze",
  Settled: "settle",
  Inbox: "return to the inbox",
};

/** The newest refused mark, in words, until it is dismissed. Its session is back where it was. */
function MarkFailure({
  failure,
  more,
  titleOf,
  onDismiss,
}: {
  readonly failure: ReturnType<typeof useMarkFailures>["failures"][number] | undefined;
  readonly more: number;
  readonly titleOf: (id: string) => string;
  readonly onDismiss: () => void;
}) {
  if (failure === undefined) return null;
  return (
    <div role="alert" className="mx-1.5 mt-2 font-mono text-[11px] leading-relaxed text-danger">
      Could not {VERB[failure.request.mark._tag]} “{titleOf(failure.request.id)}”: {failure.message}
      . It is back where it was.
      {more > 0 ? ` ${more} more did not save.` : null}{" "}
      <button
        type="button"
        onClick={onDismiss}
        className={cn("text-ink-2 underline underline-offset-2 hover:text-foreground", focusRing)}
      >
        Dismiss
      </button>
    </div>
  );
}

function InboxNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="px-2.5 pt-4 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

const focusPrompt = () => document.getElementById(PROMPT_ID)?.focus();

/** `+`: back to the composer with the cursor in it. */
function NewSessionButton() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  return (
    <IconButton
      icon="plus"
      label="New session (c)"
      bordered
      size="sm"
      onClick={() => {
        if (pathname === "/") focusPrompt();
        else void navigate({ to: "/" }).then(focusPrompt);
      }}
    />
  );
}

function Fold({
  label,
  rows,
  now,
  selectedId,
  saving,
  onMark,
  first = false,
}: {
  readonly label: "Snoozed" | "Settled";
  readonly rows: ReadonlyArray<InboxRow>;
  readonly now: Date;
  readonly selectedId: string | undefined;
  readonly saving: ReadonlySet<string>;
  readonly onMark: (id: string, mark: MarkChange) => void;
  readonly first?: boolean;
}) {
  const [shown, setShown] = useState(SETTLED_PAGE);
  return (
    <Collapsible.Root
      render={<section aria-label={label} />}
      className={first ? "border-t border-rule pt-1.5" : ""}
    >
      <Collapsible.Trigger
        className={cn(
          "group/fold flex w-full items-center gap-1.5 rounded-[10px] px-2.5 py-[9px] font-sans text-[13px] font-medium text-ink-2 hover:bg-secondary",
          focusRing,
        )}
      >
        <Icon name="chevronRight" size={13} className="group-data-[panel-open]/fold:rotate-90" />
        {label}
        <span className="font-mono text-[11px] font-normal text-faint">{rows.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {rows.length === 0 ? (
          <InboxNote>
            {label === "Snoozed"
              ? "Nothing snoozed. Hover a session and pick Snooze to hide it until later."
              : "Nothing settled yet."}
          </InboxNote>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {rows.slice(0, shown).map((row) => (
              <InboxItem
                key={row.session.id}
                row={row}
                now={now}
                selected={row.session.id === selectedId}
                saving={saving.has(row.session.id)}
                onMark={onMark}
              />
            ))}
          </ul>
        )}
        {rows.length > shown ? (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 ml-1"
            onClick={() => setShown((count) => count + SETTLED_PAGE)}
          >
            Show {Math.min(SETTLED_PAGE, rows.length - shown)} more
          </Button>
        ) : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** One session: its title, project and status; Snooze and Settle on hover or focus. */
const InboxItem = memo(function InboxItem({
  row,
  now,
  selected,
  saving,
  onMark,
}: {
  readonly row: InboxRow;
  readonly now: Date;
  readonly selected: boolean;
  readonly saving: boolean;
  readonly onMark: (id: string, mark: MarkChange) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const viewer = useViewer();
  const { openMenu, menuElement } = useContextMenu();
  const status = rowStatus(row, now);
  const { session } = row;
  const folded = row.place === "snoozed" || row.place === "settled";
  const mark = (change: MarkChange) => onMark(session.id, change);
  return (
    <li
      onContextMenu={(event) =>
        openMenu(
          event,
          sessionMenu(session, row.annotation, navigate, { queryClient, trpc }, viewer),
        )
      }
      className={cn(
        "group/row relative min-w-0 rounded-xl transition-colors",
        selected ? "bg-wash" : "hover:bg-secondary focus-within:bg-secondary",
        row.place === "settled" ? "opacity-[0.62] hover:opacity-100 focus-within:opacity-100" : "",
      )}
    >
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: session.id }}
        data-session-id={session.id}
        aria-current={selected ? "page" : undefined}
        className={cn("block rounded-xl px-2.5 py-2 no-underline", focusRing)}
      >
        <span
          className={cn(
            "block truncate font-sans text-[13px] leading-[1.35] font-medium group-focus-within/row:pr-14 group-hover/row:pr-14",
            selected ? "text-info" : "text-foreground",
          )}
        >
          {row.title}
        </span>
        <span className="mt-[3px] flex min-w-0 gap-2 font-mono text-[11px] leading-[1.4] text-muted-foreground">
          <span className="min-w-0 truncate">{row.project.name}</span>
          {/* Why a session waits can be long ("wants to run pnpm test --filter …"): it gives way. */}
          <StatusWord tone={status.tone} className={row.place === "needs-you" ? "" : "shrink-0"}>
            {status.word}
          </StatusWord>
          {row.place === "review" && row.annotation?.changeId != null ? (
            <DiffStats changeId={row.annotation.changeId} />
          ) : null}
          {saving ? <span className="shrink-0 text-faint">saving…</span> : null}
        </span>
      </Link>
      <span className="absolute top-2 right-2 hidden gap-0.5 group-focus-within/row:flex group-hover/row:flex has-[[data-popup-open]]:flex">
        {folded ? (
          <IconButton
            icon="chevronLeft"
            label={`Back to the inbox: ${row.title}`}
            size="sm"
            bordered
            onClick={() => mark({ _tag: "Inbox" })}
          />
        ) : (
          <>
            <SnoozeMenu
              title={row.title}
              now={now}
              onSnooze={(until) => mark({ _tag: "Snoozed", until })}
            />
            <IconButton
              icon="check"
              label={`Settle: ${row.title}`}
              size="sm"
              bordered
              onClick={() => mark({ _tag: "Settled" })}
            />
          </>
        )}
      </span>
      {menuElement}
    </li>
  );
});

function SnoozeMenu({
  title,
  now,
  onSnooze,
}: {
  readonly title: string;
  readonly now: Date;
  readonly onSnooze: (until: Date) => void;
}) {
  return (
    <Menu
      align="end"
      width={220}
      trigger={<IconButton icon="clock" label={`Snooze: ${title}`} size="sm" bordered />}
    >
      {snoozeChoices(now).map((choice) => (
        <MenuItem key={choice.label} onClick={() => onSnooze(choice.until)}>
          {choice.label}
          <MenuMeta>{whenAhead(choice.until, now)}</MenuMeta>
        </MenuItem>
      ))}
    </Menu>
  );
}

/** `+84 −31` for a change waiting for review: one cached read per visible row. */
function DiffStats({ changeId }: { readonly changeId: string }) {
  const trpc = useTRPC();
  const stats = useQuery(trpc.changes.stats.queryOptions({ id: changeId }, { staleTime: 60_000 }));
  if (stats.data === undefined) return null;
  if (stats.data.files === 0)
    return <span className="shrink-0 whitespace-nowrap text-faint">no file changes</span>;
  return (
    <span
      className="shrink-0 whitespace-nowrap"
      aria-label={`${stats.data.additions} lines added, ${stats.data.deletions} removed`}
    >
      <span className="text-success">+{stats.data.additions}</span>{" "}
      <span className="text-danger">−{stats.data.deletions}</span>
    </span>
  );
}
