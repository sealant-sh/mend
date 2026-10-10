import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { WorkbenchEventDto } from "#/lib/api";
import { loginWalk, useTRPC } from "#/lib/trpc";

/**
 * One SSE stream per tab, joined by every page that listens (`makeWorkbenchStream`): workbench
 * events invalidate exactly
 * the query families they point at (plan §9.4 — payloads are pointers,
 * clients re-read through the API), using the tRPC proxy's typed filters so
 * keys can never drift from the router. `session-progress` is deliberately
 * NOT an invalidation — it fires per record entry; pages that render live
 * lines take it through `onEvent` and keep component state.
 */
const LADDER_MS = [3_000, 4_000, 8_000, 16_000] as const;

/** How long the stream outlives its last listener: a navigation hands it from page to page. */
export const LINGER_MS = 1_000;

export interface WorkbenchStreamMember {
  /** Re-reads the query families an event points at (the same client for every member). */
  readonly apply: (event: WorkbenchEventDto) => void;
  /** After a reconnect: what SSE could not replay, re-read once. */
  readonly reconnected: () => void;
  readonly onEvent: ((event: WorkbenchEventDto) => void) | undefined;
}

/** One connection, as the stream sees it: the browser's `EventSource` behind `theTabStream`. */
export interface EventConnection {
  /** Closed for good (an expired session answering 401, a dead server), not a transient drop. */
  readonly closed: () => boolean;
  readonly close: () => void;
}

export interface WorkbenchStreamDeps {
  readonly connect: (on: {
    readonly open: () => void;
    readonly message: (data: string) => void;
    readonly error: () => void;
  }) => EventConnection;
  readonly later: (run: () => void, ms: number) => number;
  readonly cancel: (handle: number) => void;
  /** Runs `run` when the tab regains focus; returns the unsubscribe. */
  readonly onFocus: (run: () => void) => () => void;
}

/**
 * The tab's one event stream, shared by the shell and every page that listens: opened by the
 * first member, closed a beat after the last leaves. Every signed-in page joins it through the
 * shell, so a page whose account was removed hears why (`access`) wherever it is (live pass
 * 2026-10-10: Settings had no stream and walked to a plain sign-in), and no page opens a second
 * connection against the socket budgets. An event re-reads what it points at once, then each
 * member's own listener runs.
 */
export const makeWorkbenchStream = (deps: WorkbenchStreamDeps) => {
  const members = new Set<WorkbenchStreamMember>();
  let running = false;
  let source: EventConnection | null = null;
  let timer: number | null = null;
  let closing: number | null = null;
  let attempt = 0;
  let openedOnce = false;
  let stopFocus: (() => void) | null = null;

  const stop = () => {
    running = false;
    stopFocus?.();
    stopFocus = null;
    if (timer !== null) deps.cancel(timer);
    timer = null;
    source?.close();
    source = null;
    attempt = 0;
    openedOnce = false;
  };

  const handleMessage = (data: string) => {
    let event: WorkbenchEventDto;
    try {
      event = JSON.parse(data) as WorkbenchEventDto;
    } catch {
      return;
    }
    const [first] = members;
    first?.apply(event);
    for (const member of members) member.onEvent?.(event);
    // The account was removed from its organization: nothing more will be said to it.
    if (event.type === "user" && event.facet === "access") stop();
  };

  // The browser retries transient drops on its own; CLOSED is permanent
  // (an expired session answering 401, a dead server) and silently freezes
  // every page that trusts this stream — so a closed source is replaced on
  // a backoff ladder, and immediately when the tab regains focus.
  const open = () => {
    if (!running) return;
    timer = null;
    const next: EventConnection = deps.connect({
      open: () => {
        if (next !== source) return;
        attempt = 0;
        if (openedOnce) {
          const [first] = members;
          first?.reconnected();
        }
        openedOnce = true;
      },
      message: handleMessage,
      error: () => {
        if (!running || next !== source) return;
        if (!next.closed()) return;
        next.close();
        const delay = LADDER_MS[Math.min(attempt, LADDER_MS.length - 1)] ?? LADDER_MS[0];
        attempt += 1;
        timer = deps.later(open, delay);
      },
    });
    source = next;
  };

  const onFocus = () => {
    if (!running) return;
    if (source !== null && !source.closed()) return;
    if (timer !== null) deps.cancel(timer);
    timer = null;
    attempt = 0;
    open();
  };

  return {
    join: (member: WorkbenchStreamMember): (() => void) => {
      members.add(member);
      if (closing !== null) deps.cancel(closing);
      closing = null;
      if (!running) {
        running = true;
        stopFocus = deps.onFocus(onFocus);
        open();
      }
      return () => {
        members.delete(member);
        if (members.size > 0 || closing !== null) return;
        closing = deps.later(() => {
          closing = null;
          if (members.size === 0) stop();
        }, LINGER_MS);
      };
    },
  };
};

let tabStream: ReturnType<typeof makeWorkbenchStream> | null = null;
const theTabStream = () => {
  tabStream ??= makeWorkbenchStream({
    connect: (on) => {
      const source = new EventSource("/api/events");
      source.addEventListener("open", on.open);
      source.addEventListener("message", (message: MessageEvent<unknown>) =>
        on.message(typeof message.data === "string" ? message.data : ""),
      );
      source.addEventListener("error", on.error);
      return {
        closed: () => source.readyState === EventSource.CLOSED,
        close: () => source.close(),
      };
    },
    later: (run, ms) => window.setTimeout(run, ms),
    cancel: (handle) => window.clearTimeout(handle),
    onFocus: (run) => {
      window.addEventListener("focus", run);
      return () => window.removeEventListener("focus", run);
    },
  });
  return tabStream;
};

export const useWorkbenchEvents = (onEvent?: (event: WorkbenchEventDto) => void) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  useEffect(() => {
    const apply = (event: WorkbenchEventDto) => {
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
          // A turn's landing decision ("changes not landed · …") rides on the turn.
          void queryClient.invalidateQueries(trpc.landings.pathFilter());
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
          // A landing is recorded against the change (docs/adr/0007-landing.md).
          void queryClient.invalidateQueries(trpc.landings.pathFilter());
          // Worktree list annotations carry comment/follow-up counts.
          void queryClient.invalidateQueries(trpc.worktrees.pathFilter());
          break;
        case "user":
          // One account's own facts: the first-run checklist and Settings re-read
          // the facet named, so `mend connect` / `mend login` / `mend pair` in a
          // terminal land on the page without a reload.
          if (event.facet === "accounts") {
            void queryClient.invalidateQueries(trpc.platform.sealantIdentity.pathFilter());
            // `mend agent-logins` in a terminal lands on the page too.
            void queryClient.invalidateQueries(trpc.platform.agentLogins.pathFilter());
          } else if (event.facet === "devices") {
            void queryClient.invalidateQueries(trpc.devices.pathFilter());
          } else if (event.facet === "git-access") {
            void queryClient.invalidateQueries(trpc.git.pathFilter());
          } else if (event.facet === "access") {
            // This account was removed from its organization (docs/adr/0003): nothing cached may
            // outlive that, and the next request would be refused anyway. The stream ends too.
            queryClient.clear();
            loginWalk.accessRemoved();
          }
          break;
        case "organization":
          // Membership, roles, invitations, folders or references moved: re-read what they feed.
          void queryClient.invalidateQueries(trpc.organization.pathFilter());
          void queryClient.invalidateQueries(trpc.folders.pathFilter());
          void queryClient.invalidateQueries(trpc.git.references.pathFilter());
          void queryClient.invalidateQueries(trpc.projects.pathFilter());
          void queryClient.invalidateQueries(trpc.sessions.pathFilter());
          break;
        case "resync":
          // The server lost its event feed for a moment; anything could have changed meanwhile.
          void queryClient.invalidateQueries();
          break;
        default:
          break;
      }
    };
    return theTabStream().join({
      apply,
      // SSE carries pointers, not replay. A reconnect may have missed process/forward/
      // observation events, so refresh every mounted session's Service facts once.
      reconnected: () => {
        void queryClient.invalidateQueries(trpc.sessions.processes.pathFilter());
        void queryClient.invalidateQueries(trpc.services.list.pathFilter());
      },
      onEvent,
    });
  }, [onEvent, queryClient, trpc]);
};
