/**
 * The dashboard's side of `/api/events` (the same SSE stream the web app
 * reads): parse frames out of the byte stream, drop the `: ping` heartbeats,
 * and map each pointer event to the query families it can actually stale —
 * mirroring apps/web/src/lib/workbench-events.ts, reduced to the TUI's three
 * cache families. Pure functions; dashboard.tsx owns the socket and the
 * QueryClient.
 */

/**
 * The TUI's three cache families: ["workbench"], ["review", changeId], and
 * ["transcript", sessionId] — the detail pane's read-only output preview.
 */
export type InvalidateFamily = "workbench" | "review" | "transcript";

/**
 * An incremental SSE frame splitter: feed decoded text chunks, get back the
 * `data:` payloads of every frame completed so far. Comment-only frames (the
 * heartbeat) produce nothing.
 */
export const createSseParser = (): { readonly push: (chunk: string) => ReadonlyArray<string> } => {
  let buffer = "";
  return {
    push: (chunk) => {
      buffer += chunk;
      const payloads: Array<string> = [];
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /, ""))
          .join("\n");
        if (data !== "") payloads.push(data);
      }
      return payloads;
    },
  };
};

/**
 * Which families one event payload stales. `session-progress` is deliberately
 * nothing — it fires per record line while an agent works, and the dashboard
 * renders no live lines; treating it as a pointer refetched the entire
 * workbench on a 250ms loop for as long as a session was busy. Unknown types
 * are also nothing, like the web: every state change the TUI renders emits
 * one of the types below, and ⇧R remains the manual override.
 */
export const eventFamilies = (payload: string): ReadonlyArray<InvalidateFamily> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return [];
  switch (parsed.type) {
    case "project":
    case "worktree":
    case "session-process":
      return ["workbench"];
    // Settlement refreshes the final transcript immediately. Conversation
    // items can arrive many times per second; the live preview's bounded
    // polling reads those instead of repeatedly fetching the whole record.
    case "session":
      return ["workbench", "review", "transcript"];
    case "agent-conversation":
      return ["workbench", "review"];
    // A comment moves the review AND the dashboard's open-comment counts.
    case "session-change":
    case "review-comment":
      return ["workbench", "review"];
    default:
      return [];
  }
};
