import { useEffect, useSyncExternalStore } from "react";

import { refreshConversation } from "#/lib/conversation";
import { queryClient } from "#/lib/queries";

import type { EventsState, WorkbenchEvent } from "../../../shared/bridge";

/**
 * The workbench event stream, as main relays it: payloads are pointers
 * (plan §9.4), so each event invalidates exactly the queries it names and the
 * cockpit re-reads through the API. `session-progress` fires per record entry
 * and is deliberately not an invalidation — the terminals carry the live
 * bytes themselves.
 */
export const useWorkbenchEvents = (onEvent?: (event: WorkbenchEvent) => void) => {
  useEffect(
    () =>
      window.mend.events.onEvent((event) => {
        switch (event.type) {
          case "project":
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            if (event.projectId !== undefined) {
              void queryClient.invalidateQueries({ queryKey: ["project", event.projectId] });
            }
            break;
          case "session":
            if (event.sessionId !== undefined) {
              void queryClient.invalidateQueries({ queryKey: ["session", event.sessionId] });
            }
            if (event.projectId !== undefined) {
              void queryClient.invalidateQueries({ queryKey: ["project", event.projectId] });
            } else {
              void queryClient.invalidateQueries({ queryKey: ["project"] });
            }
            break;
          case "agent-conversation":
            // Fires per streamed delta: re-read the conversation and the detail, not every
            // query under the session (processes, recipes, the PTY-era transcript), and
            // coalesce the pointers rather than cancel the read in flight.
            if (event.sessionId !== undefined) refreshConversation(event.sessionId);
            break;
          case "session-process":
            void queryClient.invalidateQueries({ queryKey: ["services"] });
            if (event.sessionId !== undefined) {
              void queryClient.invalidateQueries({
                queryKey: ["session", event.sessionId, "processes"],
              });
            }
            break;
          case "worktree":
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            if (event.projectId !== undefined) {
              void queryClient.invalidateQueries({ queryKey: ["project", event.projectId] });
            }
            break;
          case "review-comment":
            if (event.changeId !== undefined) {
              void queryClient.invalidateQueries({
                queryKey: ["change", event.changeId, "comments"],
              });
            }
            break;
          case "session-change":
            if (event.changeId !== undefined) {
              // The immutable patch cannot change. Keep high-frequency session
              // events from re-running the full-worktree staleness probe.
              void queryClient.invalidateQueries({
                queryKey: ["change", event.changeId, "comments"],
              });
            }
            if (event.sessionId !== undefined) {
              void queryClient.invalidateQueries({ queryKey: ["session", event.sessionId] });
            }
            break;
          default:
            break;
        }
        onEvent?.(event);
      }),
    [onEvent],
  );
};

// ─── the stream's own state, for the titlebar to name ───────────────────────

let state: EventsState = "connecting";
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

const ensure = () => {
  if (unsubscribe !== null) return;
  unsubscribe = window.mend.events.onState((next) => {
    state = next;
    for (const listener of listeners) listener();
  });
};

export const useEventsState = (): EventsState =>
  useSyncExternalStore(
    (listener) => {
      ensure();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
