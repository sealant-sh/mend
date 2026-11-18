import type { TrpcProxy } from "./trpc.ts";

/**
 * How long a session's reads count as fresh. A preload on hover or touch is kept for the click
 * that follows it, and the event stream marks them stale the moment the session changes, so a
 * fresh read is never an old one.
 */
export const SESSION_STALE_MS = 30_000;

/** The session's detail: what the route preloads, the page reads and the layout marks. */
export const sessionDetailQuery = (trpc: TrpcProxy, id: string) =>
  trpc.sessions.detail.queryOptions({ id }, { staleTime: SESSION_STALE_MS });
