import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";

import type { WorkbenchEventDto } from "./api.ts";
import type { TrpcProxy } from "./trpc.ts";

/**
 * How long the inbox's rows count as fresh: the event stream keeps them current row by row, so
 * mounting the inbox again (Sessions after Settings) shows them without a second read.
 */
export const INBOX_STALE_MS = 60_000;

/** Every row of the Sessions inbox, in one read. */
export const inboxQuery = (trpc: TrpcProxy) =>
  trpc.sessions.inbox.queryOptions(undefined, { staleTime: INBOX_STALE_MS });

/**
 * Everything under `sessions` but the inbox's list: what an event about one session marks stale.
 * The list is patched row by row instead (`patchInbox`), never read whole for one session.
 */
export const sessionsButInbox = (trpc: TrpcProxy): QueryFilters => {
  const inboxKey = JSON.stringify(trpc.sessions.inbox.queryKey());
  return {
    ...trpc.sessions.pathFilter(),
    predicate: (query) => JSON.stringify(query.queryKey) !== inboxKey,
  };
};

/** What patching reads of a row: which session, worktree and change it is. */
export interface PatchableRow {
  readonly session: { readonly id: string; readonly worktreeId: string };
  readonly annotation: { readonly changeId: string | null } | null;
}

type Rows = ReadonlyArray<PatchableRow>;

/** A row read again replaces its old one, or joins the list; null takes it out. */
export const withRow = <R extends PatchableRow>(
  rows: ReadonlyArray<R>,
  id: string,
  row: R | null,
): ReadonlyArray<R> => {
  const rest = rows.filter((each) => each.session.id !== id);
  return row === null ? rest : [row, ...rest];
};

/** The ids of the rows an event is about: the session it names, or the rows of its worktree or change. */
export const rowsAbout = (event: WorkbenchEventDto, rows: Rows): ReadonlyArray<string> => {
  const ids = new Set<string>();
  if (event.sessionId !== undefined) ids.add(event.sessionId);
  for (const row of rows) {
    if (event.changeId !== undefined && row.annotation?.changeId === event.changeId)
      ids.add(row.session.id);
    if (event.worktreeId !== undefined && row.session.worktreeId === event.worktreeId)
      ids.add(row.session.id);
  }
  return [...ids];
};

/** The event types that move one session's row; the rest of the list stays as it is. */
const ROW_EVENTS: ReadonlySet<string> = new Set([
  "session",
  "session-change",
  "review-comment",
  "worktree",
]);
/** The event types that can move rows the event does not name: the list is read again. */
const LIST_EVENTS: ReadonlySet<string> = new Set(["project", "organization", "resync"]);

/**
 * Keep the inbox's cached list current from one event: re-read only the rows it is about and
 * patch them in, or read the whole list again when it names no row (a project renamed or shared,
 * membership moved). Reads for one row never overlap: an event that lands while its row is being
 * read asks for one more read when that one ends, so the row always ends on the newest state.
 */
export const makeInboxPatcher = (queryClient: QueryClient, trpc: TrpcProxy) => {
  const reading = new Map<string, { again: boolean }>();
  const key = trpc.sessions.inbox.queryKey();

  const readRow = async (id: string): Promise<void> => {
    const running = reading.get(id);
    if (running !== undefined) {
      running.again = true;
      return;
    }
    const state = { again: false };
    reading.set(id, state);
    try {
      do {
        state.again = false;
        const row = await queryClient
          .fetchQuery({
            ...trpc.sessions.inboxRow.queryOptions({ id }),
            staleTime: 0,
            gcTime: 0,
            retry: false,
          })
          .catch((error: unknown) => (isNotFound(error) ? null : undefined));
        // A failed read leaves the row as it was; the next event or reconnect reads it again.
        if (row !== undefined)
          queryClient.setQueryData<Rows>(key, (rows) =>
            rows === undefined ? rows : withRow(rows, id, row),
          );
      } while (state.again);
    } finally {
      reading.delete(id);
    }
  };

  return (event: WorkbenchEventDto): void => {
    const rows = queryClient.getQueryData<Rows>(key);
    // Nothing cached: the inbox reads the whole list when it mounts.
    if (rows === undefined) return;
    if (LIST_EVENTS.has(event.type)) {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
      return;
    }
    if (!ROW_EVENTS.has(event.type)) return;
    for (const id of rowsAbout(event, rows)) void readRow(id);
  };
};

const isNotFound = (error: unknown): boolean =>
  error instanceof TRPCClientError && error.data?.code === "NOT_FOUND";
