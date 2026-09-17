import { Effect } from "effect";
import type { HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import type { Budgets, BudgetName } from "./budgets.ts";
import type { ConnectionKind, ConnectionRegistry } from "./connections.ts";
import { budgetRefusal } from "./request-budgets.ts";

const BUDGET_OF: Readonly<Record<ConnectionKind, BudgetName>> = {
  "event-stream": "accountEventStreams",
  terminal: "accountTerminals",
  tunnel: "accountTunnels",
  "key-bridge": "accountKeyBridges",
};

/**
 * The refusal for one more long-lived connection of `kind`, or null when the account has room
 * (docs/adr/0004, "Budgets"). Asked after authentication and before anything is dialled or
 * upgraded, so a refused connection has attached to nothing. Connections already open stay open.
 * Two that arrive together can both pass; the count is of what this process holds, which is what
 * bounds this process's memory.
 */
export const connectionRefusal = (
  budgets: Budgets["Service"],
  connections: ConnectionRegistry["Service"],
  userId: string,
  kind: ConnectionKind,
): Effect.Effect<HttpServerResponse.HttpServerResponse | null> =>
  Effect.map(connections.countFor(userId, kind), (open) => {
    const name = BUDGET_OF[kind];
    const limit = budgets.limits[name];
    return limit > 0 && open >= limit ? budgetRefusal(429, name, limit, null) : null;
  });

const frameSize = (data: string | Uint8Array): number =>
  typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;

/**
 * A frame guard for one socket: a frame over the budget closes the socket with 1009 (message too
 * big), once, and every later frame is dropped.
 *
 * The WebSocket server that Effect's Node HTTP server builds is not configurable, so the `ws`
 * library has already buffered the frame by the time a handler sees it, up to its own 100 MiB
 * default. This bounds what Mend forwards and ends the connection; together with the connection
 * budget it bounds the total, not the single frame (docs/adr/0004, decision 12).
 */
export const makeFrameGuard = <E>(
  limit: number,
  write: (event: Socket.CloseEvent) => Effect.Effect<void, E>,
) => {
  let closed = false;
  return {
    /** Null when the frame is admitted; otherwise what the handler returns in place of handling it. */
    refuse: (data: string | Uint8Array): Effect.Effect<void> | null => {
      if (closed) return Effect.void;
      if (limit <= 0 || frameSize(data) <= limit) return null;
      closed = true;
      return write(new Socket.CloseEvent(1009, "frame over budget")).pipe(Effect.ignore);
    },
  };
};
