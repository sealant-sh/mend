import {
  hashKey,
  type QueryCacheNotifyEvent,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { agentIsLive, type SessionDetailDto, type SessionInboxRowDto } from "./api.ts";
import { isAlive } from "./inbox.ts";

/**
 * Stops this tab sent that Mend hasn't caught up with yet (SLNT-1212). The moment a person
 * confirms Stop, the session reads as stopped everywhere it shows: its inbox row (the sidebar's
 * word and glyph, and the group the inbox's own rules give an ended session: To review with
 * changed files, Done without), its tab, its page and its composer. All of them read two cached
 * reads, the inbox's rows and the session's detail, so the stop is laid over those two, and laid
 * again over any read of them that lands before the server says the session ended (an event, a
 * refetch): the session never flickers back to Running while it is saved and stopped.
 *
 * - The server says it ended: the stop is done; its own rows and detail stand from then on.
 * - The stop failed: the rows and detail go back to what they were, and are read again.
 * - The server took the stop but still says it is stopping after `STOP_CATCH_UP_MS`: the stop is
 *   let go and the reads are read again, so nothing reads stopped on this tab's word alone for
 *   long.
 *
 * Tab memory only: a reload shows what the server holds.
 */

/** How long a stop the server took may read as stopped before the server says so itself. */
export const STOP_CATCH_UP_MS = 120_000;

/** The keys of the two reads a stop is laid over. */
export interface StopKeys {
  readonly inbox: QueryKey;
  readonly detail: (sessionId: string) => QueryKey;
}

/** The session's inbox row as stopped at `at`; an ended row is already what it should be. */
export const stoppedRow = (row: SessionInboxRowDto, at: Date): SessionInboxRowDto =>
  isAlive(row.session.status)
    ? {
        ...row,
        turnOpen: false,
        activity: null,
        session: { ...row.session, status: "stopped", updatedAt: at, settledAt: at },
      }
    : row;

/** Whether the server's detail still has the agent up, or on its way down. */
const runsStill = (detail: SessionDetailDto): boolean =>
  detail.session.status === "stopping" || agentIsLive(detail.session, detail.currentAgent);

/** The session's detail as stopped at `at`: the session stopped, its agent exited. */
export const stoppedDetail = (detail: SessionDetailDto, at: Date): SessionDetailDto => {
  if (!runsStill(detail)) return detail;
  const agent = detail.currentAgent;
  return {
    ...detail,
    session: { ...detail.session, status: "stopped", updatedAt: at, settledAt: at },
    currentAgent:
      agent === null || agent.exitedAt !== null
        ? agent
        : { ...agent, status: "exited", exitedAt: at },
  };
};

interface PendingStop {
  readonly at: Date;
  /** The server answered that it took the stop. */
  accepted: boolean;
  /** What the reads held before the stop was laid over them, to put back if it fails. */
  readonly before: {
    readonly row: SessionInboxRowDto | undefined;
    readonly detail: SessionDetailDto | undefined;
  };
  readonly detailHash: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Stops {
  readonly keys: StopKeys;
  readonly inboxHash: string;
  readonly pending: Map<string, PendingStop>;
  unsubscribe: (() => void) | null;
}

const registries = new WeakMap<QueryClient, Stops>();

const stopsOf = (queryClient: QueryClient, keys: StopKeys): Stops => {
  const known = registries.get(queryClient);
  if (known !== undefined) return known;
  const made: Stops = {
    keys,
    inboxHash: hashKey(keys.inbox),
    pending: new Map(),
    unsubscribe: null,
  };
  registries.set(queryClient, made);
  return made;
};

/**
 * Whether a session read is the stop laid over it, not the server's: the cache copies what it is
 * given (structural sharing), so a read is told apart by the stop's own time, which no server
 * answer carries.
 */
const laidOver = (
  session: { readonly status: string; readonly updatedAt: Date },
  stop: PendingStop,
): boolean => session.status === "stopped" && session.updatedAt.getTime() === stop.at.getTime();

/** Lets the stop go and stops watching the cache once no stop is on its way. */
const forget = (stops: Stops, sessionId: string): void => {
  const stop = stops.pending.get(sessionId);
  if (stop?.timer != null) clearTimeout(stop.timer);
  stops.pending.delete(sessionId);
  if (stops.pending.size === 0) {
    stops.unsubscribe?.();
    stops.unsubscribe = null;
  }
};

/** The rows with every stop on its way laid over them; the same list when nothing changed. */
const overRows = (
  stops: Stops,
  rows: ReadonlyArray<SessionInboxRowDto>,
): ReadonlyArray<SessionInboxRowDto> => {
  let changed = false;
  const ended: Array<string> = [];
  const next = rows.map((row) => {
    const stop = stops.pending.get(row.session.id);
    if (stop === undefined || laidOver(row.session, stop)) return row;
    // The server's own row says the session ended: the stop is done.
    if (!isAlive(row.session.status)) {
      ended.push(row.session.id);
      return row;
    }
    changed = true;
    return stoppedRow(row, stop.at);
  });
  for (const id of ended) forget(stops, id);
  return changed ? next : rows;
};

const overDetail = (
  stops: Stops,
  sessionId: string,
  detail: SessionDetailDto,
): SessionDetailDto => {
  const stop = stops.pending.get(sessionId);
  if (stop === undefined || laidOver(detail.session, stop)) return detail;
  if (!runsStill(detail)) {
    forget(stops, sessionId);
    return detail;
  }
  return stoppedDetail(detail, stop.at);
};

/** Lays the stops over whatever lands in the two reads while one is on its way. */
const watch = (queryClient: QueryClient, stops: Stops): void => {
  if (stops.unsubscribe !== null) return;
  stops.unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const { query } = event;
    if (query.queryHash === stops.inboxHash) {
      const rows = queryClient.getQueryData<ReadonlyArray<SessionInboxRowDto>>(stops.keys.inbox);
      if (rows === undefined) return;
      const next = overRows(stops, rows);
      if (next !== rows) queryClient.setQueryData(stops.keys.inbox, next);
      return;
    }
    for (const [sessionId, stop] of stops.pending) {
      if (query.queryHash !== stop.detailHash) continue;
      const detail = queryClient.getQueryData<SessionDetailDto>(stops.keys.detail(sessionId));
      if (detail === undefined) return;
      const next = overDetail(stops, sessionId, detail);
      if (next !== detail) queryClient.setQueryData(stops.keys.detail(sessionId), next);
      return;
    }
  });
};

/**
 * The person confirmed Stop: from now the session reads as stopped in both reads, until the server
 * says it ended (`acceptStop`) or the stop fails (`undoStop`).
 */
export const beginStop = (
  queryClient: QueryClient,
  keys: StopKeys,
  sessionId: string,
  at: Date = new Date(),
): void => {
  const stops = stopsOf(queryClient, keys);
  const rows = queryClient.getQueryData<ReadonlyArray<SessionInboxRowDto>>(keys.inbox);
  const detail = queryClient.getQueryData<SessionDetailDto>(keys.detail(sessionId));
  forget(stops, sessionId);
  stops.pending.set(sessionId, {
    at,
    accepted: false,
    before: { row: rows?.find((row) => row.session.id === sessionId), detail },
    detailHash: hashKey(keys.detail(sessionId)),
    timer: null,
  });
  watch(queryClient, stops);
  if (rows !== undefined) {
    const next = overRows(stops, rows);
    if (next !== rows) queryClient.setQueryData(keys.inbox, next);
  }
  if (detail !== undefined) {
    const next = overDetail(stops, sessionId, detail);
    if (next !== detail) queryClient.setQueryData(keys.detail(sessionId), next);
  }
};

/**
 * The server took the stop. The session keeps reading as stopped until the server says so too, or
 * for `STOP_CATCH_UP_MS` at most; then the reads are read again.
 */
export const acceptStop = (queryClient: QueryClient, sessionId: string): void => {
  const stops = registries.get(queryClient);
  const stop = stops?.pending.get(sessionId);
  if (stops === undefined || stop === undefined || stop.accepted) return;
  stop.accepted = true;
  stop.timer = setTimeout(() => {
    forget(stops, sessionId);
    void queryClient.invalidateQueries({ queryKey: stops.keys.inbox, exact: true });
    void queryClient.invalidateQueries({ queryKey: stops.keys.detail(sessionId), exact: true });
  }, STOP_CATCH_UP_MS);
};

/**
 * The stop failed: the row and the detail go back to what they were where the stop is still laid
 * over them, and both are read again.
 */
export const undoStop = (queryClient: QueryClient, sessionId: string): void => {
  const stops = registries.get(queryClient);
  const stop = stops?.pending.get(sessionId);
  if (stops === undefined || stop === undefined) return;
  forget(stops, sessionId);
  const { row: before, detail } = stop.before;
  queryClient.setQueryData<ReadonlyArray<SessionInboxRowDto>>(stops.keys.inbox, (rows) =>
    rows?.map((row) =>
      row.session.id === sessionId && laidOver(row.session, stop) && before !== undefined
        ? before
        : row,
    ),
  );
  queryClient.setQueryData<SessionDetailDto>(stops.keys.detail(sessionId), (current) =>
    current !== undefined && laidOver(current.session, stop) && detail !== undefined
      ? detail
      : current,
  );
  void queryClient.invalidateQueries({ queryKey: stops.keys.inbox, exact: true });
  void queryClient.invalidateQueries({ queryKey: stops.keys.detail(sessionId), exact: true });
};

/** Whether a stop of the session is on its way from this tab (for tests and words). */
export const stopPending = (queryClient: QueryClient, sessionId: string): boolean =>
  registries.get(queryClient)?.pending.has(sessionId) ?? false;
