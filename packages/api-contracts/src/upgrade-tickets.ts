import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware } from "./common.ts";

/**
 * Upgrade tickets (docs/adr/0004-access-without-a-private-network.md, "Upgrade tickets"; MEND-08).
 * A ticket is the only credential that rides a URL: single use, thirty seconds, one account, one
 * target, that target's exact parameters.
 */
export const UpgradeTicketTarget = Schema.Literals([
  "tty",
  "service-tunnel",
  "keys-bridge",
  "tty-embed",
]);
export type UpgradeTicketTarget = typeof UpgradeTicketTarget.Type;

/**
 * What the ticket opens. Exactly the addressing parameters the target route reads: `process` or
 * `session` for a terminal and its embed, `service` for a tunnel, `host` for the key bridge. A
 * ticket opens that and nothing else.
 */
export class UpgradeTicketRequest extends Schema.Class<UpgradeTicketRequest>(
  "UpgradeTicketRequest",
)({
  target: UpgradeTicketTarget,
  process: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  service: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
}) {}

export class UpgradeTicket extends Schema.Class<UpgradeTicket>("UpgradeTicket")({
  /** Shown once. Append as `?ticket=` to the target's URL. */
  ticket: Schema.String,
  expiresInSeconds: Schema.Int,
}) {}

/** The parameters do not address the target (a tunnel ticket with no `service`). */
export class UpgradeTicketInvalid extends Schema.TaggedErrorClass<UpgradeTicketInvalid>()(
  "UpgradeTicketInvalid",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Unknown, expired, already used, or minted for something else. One answer for all four. */
export class UpgradeTicketRefused extends Schema.TaggedErrorClass<UpgradeTicketRefused>()(
  "UpgradeTicketRefused",
  {},
  { httpApiStatus: 401 },
) {}

export const upgradeTicketsGroup = HttpApiGroup.make("upgradeTickets")
  .add(
    HttpApiEndpoint.post("mint", "/upgrade-tickets", {
      payload: UpgradeTicketRequest,
      success: UpgradeTicket,
      error: UpgradeTicketInvalid,
    }),
  )
  .middleware(AuthMiddleware);

export class EmbedTickets extends Schema.Class<EmbedTickets>("EmbedTickets")({
  /** For the socket: `?ticket=` on `/api/tty`, thirty seconds, single use. */
  ticket: Schema.String,
  /**
   * For the next exchange, when the page reconnects. Kept in the page's memory and sent only in a
   * request body, never in a URL. Every exchange replaces it.
   */
  renew: Schema.String,
  expiresInSeconds: Schema.Int,
}) {}

/**
 * The embed page holds no credential but the ticket in its own URL. It trades that for a `tty`
 * ticket with the same parameters, so no bearer ever reaches a WebView's URL, history or referrer,
 * and for a renewal ticket it keeps in memory, so a dropped socket can reconnect without the app
 * minting a new URL. Unauthenticated by construction: the ticket is the credential, and it is spent
 * by the trade.
 */
export const upgradeTicketExchangeGroup = HttpApiGroup.make("upgradeTicketExchange").add(
  HttpApiEndpoint.post("exchange", "/upgrade-tickets/exchange", {
    payload: Schema.Struct({
      ticket: Schema.String,
      process: Schema.optional(Schema.String),
      session: Schema.optional(Schema.String),
    }),
    success: EmbedTickets,
    error: UpgradeTicketRefused,
  }),
);
