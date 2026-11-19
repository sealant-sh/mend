import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { inboxQuery } from "./inbox-live.ts";
import {
  groupRows,
  inboxRows,
  matchesFilters,
  type InboxFilters,
  type InboxGroup,
  type InboxRow,
  type QueuedRow,
  queuedRows,
} from "./inbox.ts";
import { labelsWriter, marksWriter } from "./row-actions.ts";
import { signedInOptions } from "./sign-in.ts";
import { useTRPC } from "./trpc.ts";
import { inboxFilters } from "./ui-prefs.ts";

const subscribeToMinutes = (onChange: () => void) => {
  const timer = setInterval(onChange, 15_000);
  return () => clearInterval(timer);
};
const minuteNow = () => Math.floor(Date.now() / 60_000);

/** The current minute; re-renders only when it turns, so "4m" stays true. */
export const useMinute = (): Date => {
  const minute = useSyncExternalStore(subscribeToMinutes, minuteNow, minuteNow);
  // One Date per minute, so the memoized rows keep their props between minutes.
  return useMemo(() => new Date(minute * 60_000), [minute]);
};

/** The person's marks on sessions (snoozed, done, kept in the inbox). */
export const inboxMarksQuery = (trpc: ReturnType<typeof useTRPC>) =>
  trpc.sessions.inboxMarks.queryOptions(undefined, { staleTime: 60_000 });

/** How often queued sessions are read while one waits: no event says when one moves. */
const QUEUED_MS = 2_000;

/** The caller's queued sessions, read again every two seconds while one waits or starts. */
export const queuedSessionsQuery = (trpc: ReturnType<typeof useTRPC>) =>
  trpc.queuedSessions.list.queryOptions(undefined, {
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.state === "waiting" || row.state === "starting") === true
        ? QUEUED_MS
        : false,
  });

/** The inbox as the sidebar and the phone screen show it, once its reads are in. */
export interface InboxView {
  /** Every row the filters let through, in its group. */
  readonly groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>;
  /**
   * Sessions started while their project clones, not sessions yet, by the group they wait in.
   * Listed only with every project shown: they carry no project id until they start.
   */
  readonly queued: Readonly<Record<"running" | "review", ReadonlyArray<QueuedRow>>>;
  /** Every row the person can see, filters aside: the shared-workspace count reads these. */
  readonly all: ReadonlyArray<InboxRow>;
  /**
   * Nothing to list across every project: "No sessions yet" in place of the groups. With one
   * project picked, the groups show, each saying it is empty.
   */
  readonly empty: boolean;
  /** When the rows were read, for the offline line. */
  readonly readAt: Date;
  readonly filters: InboxFilters;
  readonly now: Date;
  /** Who is signed in: only a session's owner renames it. */
  readonly viewerId: string;
  /** Reads the rows and the marks again. */
  readonly refresh: () => void;
}

export type InboxState =
  | { readonly status: "pending" }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retry: () => void;
      readonly retrying: boolean;
    }
  | { readonly status: "success"; readonly view: InboxView };

/**
 * The inbox's reads put together: its rows, the person's marks, who they are (for "Mine"), and the
 * filters this browser keeps.
 */
export const useInbox = (): InboxState => {
  const trpc = useTRPC();
  const now = useMinute();
  const filters = inboxFilters.use();
  const inbox = useQuery(inboxQuery(trpc));
  const marks = useQuery(inboxMarksQuery(trpc));
  // The root route read who is signed in before any signed-in page renders.
  const viewer = useSuspenseQuery(signedInOptions(trpc));
  const queuedRead = useQuery(queuedSessionsQuery(trpc));
  // A queued session that left the list started (or was cancelled): the inbox reads its session.
  const queuedIds = (queuedRead.data ?? []).map((row) => row.id).join(",");
  const lastQueued = useRef(queuedIds);
  const refetchInbox = inbox.refetch;
  // Following the server: the list moved, so the inbox is read again. An effect, since nothing
  // but this read says a queued session became a session.
  useEffect(() => {
    const before = lastQueued.current.split(",").filter((id) => id !== "");
    lastQueued.current = queuedIds;
    if (before.some((id) => !queuedIds.split(",").includes(id))) void refetchInbox();
  }, [queuedIds, refetchInbox]);
  // A failed read of queued sessions leaves them out; the sessions themselves still list.
  const queuedList = queuedRead.isPending || queuedRead.isError ? undefined : queuedRead.data;
  const queued = useMemo(() => {
    const rows = filters.projectId === null ? queuedRows(queuedList ?? []) : [];
    return {
      running: rows.filter((row) => row.group === "running"),
      review: rows.filter((row) => row.group === "review"),
    };
  }, [queuedList, filters.projectId]);
  const me = viewer.data.userId;
  // What the person sees: the server's rows and marks, with their renames and marks still on
  // their way laid over them (a row's actions, `lib/row-actions.ts`).
  const visibleRows = labelsWriter.useVisible(inbox.data);
  const visibleMarks = marksWriter.useVisible(marks.data);
  // Who asks for shared control is named from the roster; until it is read, the row says someone.
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  const roster = members.isPending || members.isError ? undefined : members.data;
  const all = useMemo(() => {
    const names = new Map((roster ?? []).map((member) => [member.userId, member.name]));
    return inboxRows({
      rows: visibleRows ?? [],
      marks: visibleMarks ?? [],
      now,
      nameOf: (userId) => names.get(userId) ?? null,
    });
  }, [visibleRows, visibleMarks, now, roster]);
  const groups = useMemo(
    () => groupRows(all.filter((row) => matchesFilters(row, filters, me))),
    [all, filters, me],
  );
  // A read that failed with nothing read before it is the inbox's failure. One that failed after
  // an earlier read (offline, a server restart) keeps the rows it has: the offline band, or the
  // next event or reconnect, says the rest.
  const failed =
    (inbox.isError && inbox.data === undefined) || (marks.isError && marks.data === undefined);
  if (failed)
    return {
      status: "error",
      error: inbox.error ?? marks.error,
      retry: () => {
        if (inbox.isError) void inbox.refetch();
        if (marks.isError) void marks.refetch();
      },
      retrying: inbox.isFetching || marks.isFetching,
    };
  if (inbox.isPending || marks.isPending) return { status: "pending" };
  return {
    status: "success",
    view: {
      groups,
      queued,
      all,
      empty:
        filters.projectId === null &&
        Object.values(groups).every((rows) => rows.length === 0) &&
        queued.running.length + queued.review.length === 0,
      readAt: new Date(inbox.dataUpdatedAt),
      filters,
      now,
      viewerId: me,
      refresh: () => {
        void inbox.refetch();
        void marks.refetch();
      },
    },
  };
};
