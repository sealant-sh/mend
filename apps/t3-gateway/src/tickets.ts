import { randomBytes } from "node:crypto";

import type { AuthSessionId } from "@mend/t3-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * WebSocket tickets: what `POST /api/auth/websocket-ticket` hands out and `/ws?wsTicket=` spends.
 * Gateway-local, single use and thirty seconds long, like Mend's own upgrade tickets (ADR 0004).
 * They live in memory: a restart only makes clients ask for a new one, which they do per connect.
 */

export const WEBSOCKET_TICKET_TTL_MS = 30_000;

export interface IssuedTicket {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}

export class WebSocketTickets extends Context.Service<
  WebSocketTickets,
  {
    readonly issue: (sessionId: AuthSessionId) => Effect.Effect<IssuedTicket>;
    /** The ticket's session, once: a second spend, or a spend after expiry, finds nothing. */
    readonly consume: (ticket: string) => Effect.Effect<Option.Option<AuthSessionId>>;
  }
>()("@mend/t3-gateway/WebSocketTickets") {}

export const WebSocketTicketsLive: Layer.Layer<WebSocketTickets> = Layer.sync(
  WebSocketTickets,
  () => {
    const open = new Map<
      string,
      { readonly sessionId: AuthSessionId; readonly expiresAt: number }
    >();

    const sweep = (now: number) => {
      for (const [ticket, entry] of open) {
        if (entry.expiresAt <= now) open.delete(ticket);
      }
    };

    const issue = (sessionId: AuthSessionId) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        sweep(now);
        const ticket = `wst_${randomBytes(32).toString("base64url")}`;
        const expiresAt = now + WEBSOCKET_TICKET_TTL_MS;
        open.set(ticket, { sessionId, expiresAt });
        return { ticket, expiresAt: DateTime.makeUnsafe(expiresAt) };
      });

    const consume = (ticket: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const entry = open.get(ticket);
        open.delete(ticket);
        sweep(now);
        if (entry === undefined || entry.expiresAt <= now) return Option.none<AuthSessionId>();
        return Option.some(entry.sessionId);
      });

    return { issue, consume };
  },
);
