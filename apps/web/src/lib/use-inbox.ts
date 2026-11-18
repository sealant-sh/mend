import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";

import { inboxQuery } from "./inbox-live.ts";
import {
  groupRows,
  inboxRows,
  matchesFilters,
  type InboxFilters,
  type InboxGroup,
  type InboxRow,
} from "./inbox.ts";
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

/** The inbox as the sidebar and the phone screen show it, once its reads are in. */
export interface InboxView {
  /** Every row the filters let through, in its group. */
  readonly groups: Readonly<Record<InboxGroup, ReadonlyArray<InboxRow>>>;
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
 * The inbox's reads put together: its rows, the person's marks, who they are (for "Mine"), the
 * filters this browser keeps, and, for each Idle session, how many files its change has.
 */
export const useInbox = (): InboxState => {
  const trpc = useTRPC();
  const now = useMinute();
  const filters = inboxFilters.use();
  const inbox = useQuery(inboxQuery(trpc));
  const marks = useQuery(inboxMarksQuery(trpc));
  // The root route read who is signed in before any signed-in page renders.
  const viewer = useSuspenseQuery(signedInOptions(trpc));
  const idleChanges = useMemo(
    () => [
      ...new Set(
        (inbox.data ?? []).flatMap((row) =>
          row.session.status === "idle" && row.annotation?.changeId != null
            ? [row.annotation.changeId]
            : [],
        ),
      ),
    ],
    [inbox.data],
  );
  // An Idle session's change, read for its file count; one that hasn't answered counts as none.
  const changedFiles = useQueries({
    queries: idleChanges.map((id) =>
      trpc.changes.stats.queryOptions({ id }, { staleTime: 60_000 }),
    ),
    // A plain object, which Query shares structurally: it keeps its identity while no count moves.
    combine: (results): Readonly<Record<string, number>> =>
      Object.fromEntries(
        results.flatMap((result, index) => {
          const id = idleChanges[index];
          return id === undefined || result.data === undefined ? [] : [[id, result.data.files]];
        }),
      ),
  });
  const me = viewer.data.userId;
  const all = useMemo(
    () => inboxRows({ rows: inbox.data ?? [], marks: marks.data ?? [], changedFiles, now }),
    [inbox.data, marks.data, changedFiles, now],
  );
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
      all,
      empty: filters.projectId === null && Object.values(groups).every((rows) => rows.length === 0),
      readAt: new Date(inbox.dataUpdatedAt),
      filters,
      now,
      refresh: () => {
        void inbox.refetch();
        void marks.refetch();
      },
    },
  };
};
