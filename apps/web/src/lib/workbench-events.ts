import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { WorkbenchEventDto } from "#/lib/api";
import { isConversationKey, makeConversationPatcher } from "#/lib/conversation-live";
import { invalidationsFor } from "#/lib/event-scope";
import { makeInboxPatcher, sessionsButPatched } from "#/lib/inbox-live";
import { accessDestination, shownOrganizationMoved } from "#/lib/organization";
import { loginWalk, type TrpcProxy, useTRPC, useTRPCClient } from "#/lib/trpc";
import { signedInOptions } from "#/lib/viewer";

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
    /** Ends the stream now, rather than a beat after its last member leaves. */
    close: () => {
      members.clear();
      if (closing !== null) deps.cancel(closing);
      closing = null;
      stop();
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

/** Ends the tab's stream at once; a test file calls it while its window still exists. */
export const closeTabStream = () => tabStream?.close();

/**
 * After a reconnect: SSE carries pointers, not replay, so anything an event would have pointed at
 * meanwhile (a finished turn, a question the agent asked, a review comment, a landing, a Service)
 * is read again once. A conversation reads on from the item cursor it already holds, so this
 * fetches only what changed while the stream was down.
 */
export const refreshAfterReconnect = (queryClient: QueryClient, trpc: TrpcProxy) => {
  for (const filter of [
    // The conversations' pages read on from their feed instead (`makeConversationPatcher`).
    sessionsButPatched(trpc),
    trpc.sessions.inbox.queryFilter(),
    trpc.screens.pathFilter(),
    trpc.changes.pathFilter(),
    trpc.landings.pathFilter(),
    trpc.services.pathFilter(),
    trpc.worktrees.pathFilter(),
    trpc.projects.pathFilter(),
    trpc.organization.pathFilter(),
    trpc.organizations.list.queryFilter(),
    // The person's own switches and new-session defaults, saved on another device meanwhile.
    trpc.platform.automation.pathFilter(),
    trpc.platform.sessionDefaults.pathFilter(),
  ])
    void queryClient.invalidateQueries(filter);
};

export const useWorkbenchEvents = (onEvent?: (event: WorkbenchEventDto) => void) => {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const client = useTRPCClient();
  useEffect(() => {
    const patchInbox = makeInboxPatcher(queryClient, trpc);
    const patchConversation = makeConversationPatcher(queryClient, trpc, client);
    const apply = (event: WorkbenchEventDto) => {
      patchInbox(event);
      patchConversation.apply(event);
      // The conversations' pages are patched above, never read again for an event.
      for (const filter of invalidationsFor(event, trpc, (query) =>
        isConversationKey(query.queryKey),
      ))
        void queryClient.invalidateQueries(filter);
      switch (event.type) {
        case "user":
          // One account's own facts: the first-run checklist and Settings re-read
          // the facet named, so `mend connect` / `mend login` / `mend pair` in a
          // terminal land on the page without a reload.
          if (event.facet === "accounts") {
            void queryClient.invalidateQueries(trpc.platform.sealantIdentity.pathFilter());
            // `mend agent-logins` in a terminal lands on the page too.
            void queryClient.invalidateQueries(trpc.platform.agentLogins.pathFilter());
            void queryClient.invalidateQueries(trpc.platform.messageSettings.pathFilter());
            // A person's own switches and new-session defaults, saved on another device.
            void queryClient.invalidateQueries(trpc.platform.automation.pathFilter());
            void queryClient.invalidateQueries(trpc.platform.sessionDefaults.pathFilter());
          } else if (event.facet === "devices") {
            void queryClient.invalidateQueries(trpc.devices.pathFilter());
            // Access keys share the paired-device store and its event (docs/adr/0023).
            void queryClient.invalidateQueries(trpc.accessKeys.pathFilter());
          } else if (event.facet === "git-access") {
            void queryClient.invalidateQueries(trpc.git.pathFilter());
          } else if (event.facet === "access") {
            // This account left or lost the organization this tab acts in (docs/adr/0003): nothing
            // cached may outlive that. The stream ends too.
            queryClient.clear();
            if (accessDestination(event) === "home") loginWalk.organizationChanged();
            else loginWalk.accessRemoved();
          }
          break;
        case "sign-in-organization":
          // One of this account's sign-ins switched: this tab's own, which every tab of this
          // browser shares, or another device's, which moves nothing here.
          followSignInOrganization();
          break;
        default:
          break;
      }
    };
    /** Starts the tab over when its sign-in now acts in another organization than it shows. */
    const followSignInOrganization = () => {
      const shown = queryClient.getQueryData(trpc.organization.current.queryKey());
      void queryClient.fetchQuery({ ...signedInOptions(trpc), staleTime: 0 }).then(
        (now) =>
          shownOrganizationMoved(shown?.organization.id, now.organization.id)
            ? loginWalk.organizationChanged()
            : undefined,
        () => undefined,
      );
    };
    return theTabStream().join({
      apply,
      // SSE carries pointers, not replay. A reconnect may have missed process/forward/
      // observation events, so refresh every mounted session's Service facts once, and a
      // switch made in another tab while the stream was down is caught here.
      reconnected: () => {
        followSignInOrganization();
        refreshAfterReconnect(queryClient, trpc);
        patchConversation.all();
      },
      onEvent,
    });
  }, [onEvent, queryClient, trpc, client]);
};
