import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { WorkbenchEventDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * One SSE subscription per mounted page: workbench events invalidate exactly
 * the query families they point at (plan §9.4 — payloads are pointers,
 * clients re-read through the API), using the tRPC proxy's typed filters so
 * keys can never drift from the router. `session-progress` is deliberately
 * NOT an invalidation — it fires per record entry; pages that render live
 * lines take it through `onEvent` and keep component state.
 */
const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;

export const useWorkbenchEvents = (onEvent?: (event: WorkbenchEventDto) => void) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: number | null = null;
    let attempt = 0;
    let openedOnce = false;
    let disposed = false;

    const handleMessage = (message: MessageEvent<string>) => {
      let event: WorkbenchEventDto;
      try {
        event = JSON.parse(message.data) as WorkbenchEventDto;
      } catch {
        return;
      }
      switch (event.type) {
        case "project":
          void queryClient.invalidateQueries(trpc.projects.pathFilter());
          if (event.projectId !== undefined) {
            void queryClient.invalidateQueries(trpc.environment.pathFilter());
          }
          break;
        case "session":
          void queryClient.invalidateQueries(trpc.sessions.pathFilter());
          if (event.projectId !== undefined) {
            void queryClient.invalidateQueries(trpc.projects.pathFilter());
          }
          break;
        case "agent-conversation":
          // The old entity-prefix key refreshed EVERY session-scoped query
          // (detail, transcript, pending follow-up, processes) — a follow-up
          // banner staling on another device taught us not to enumerate.
          void queryClient.invalidateQueries(trpc.sessions.pathFilter());
          break;
        case "session-process":
          if (event.sessionId !== undefined) {
            void queryClient.invalidateQueries(
              trpc.sessions.processes.queryFilter({ id: event.sessionId }),
            );
            void queryClient.invalidateQueries(trpc.services.list.pathFilter());
          }
          break;
        case "worktree":
          // The container changed: created, renamed, removed, hot state.
          void queryClient.invalidateQueries(trpc.worktrees.pathFilter());
          void queryClient.invalidateQueries(trpc.projects.pathFilter());
          break;
        case "session-change":
        case "review-comment":
          void queryClient.invalidateQueries(trpc.changes.pathFilter());
          // Worktree list annotations carry comment/follow-up counts.
          void queryClient.invalidateQueries(trpc.worktrees.pathFilter());
          break;
        case "user":
          // One account's own facts: the first-run checklist and Settings re-read
          // the facet named, so `mend connect` / `mend login` / `mend pair` in a
          // terminal land on the page without a reload.
          if (event.facet === "accounts") {
            void queryClient.invalidateQueries(trpc.platform.sealantIdentity.pathFilter());
          } else if (event.facet === "devices") {
            void queryClient.invalidateQueries(trpc.devices.pathFilter());
          } else if (event.facet === "git-access") {
            void queryClient.invalidateQueries(trpc.git.pathFilter());
          }
          break;
        default:
          break;
      }
      onEvent?.(event);
    };

    // The browser retries transient drops on its own; CLOSED is permanent
    // (an expired session answering 401, a dead server) and silently freezes
    // every page that trusts this stream — so a closed source is replaced on
    // a backoff ladder, and immediately when the tab regains focus.
    const open = () => {
      if (disposed) return;
      const next = new EventSource("/api/events");
      source = next;
      next.addEventListener("open", () => {
        if (next !== source) return;
        attempt = 0;
        if (openedOnce) {
          // SSE carries pointers, not replay. A reconnect may have missed process/forward/
          // observation events, so refresh every mounted session's Service facts once.
          void queryClient.invalidateQueries(trpc.sessions.processes.pathFilter());
          void queryClient.invalidateQueries(trpc.services.list.pathFilter());
        }
        openedOnce = true;
      });
      next.addEventListener("message", handleMessage);
      next.addEventListener("error", () => {
        if (disposed || next !== source) return;
        if (next.readyState !== EventSource.CLOSED) return;
        next.close();
        const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)];
        attempt += 1;
        timer = window.setTimeout(open, delay);
      });
    };
    const onFocus = () => {
      if (disposed) return;
      if (source !== null && source.readyState !== EventSource.CLOSED) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
      open();
    };
    window.addEventListener("focus", onFocus);
    open();
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      if (timer !== null) window.clearTimeout(timer);
      source?.close();
    };
  }, [onEvent, queryClient, trpc]);
};
