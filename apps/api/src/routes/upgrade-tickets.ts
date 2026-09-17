import {
  CurrentUser,
  EmbedTickets,
  MendApi,
  UpgradeTicket,
  UpgradeTicketInvalid,
  UpgradeTicketRefused,
  type UpgradeTicketRequest,
} from "@mend/api-contracts";
import type { Auth } from "@mend/auth";
import {
  OrganizationsRepo,
  UPGRADE_RENEWAL_TTL_MS,
  UPGRADE_TICKET_TTL_MS,
  UpgradeTicketsRepo,
  upgradeTicketScope,
  type UpgradeTicketTarget,
} from "@mend/db";
import { redactUrl } from "@mend/network";
import { Config, Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/**
 * Upgrade tickets (docs/adr/0004-access-without-a-private-network.md, "Upgrade tickets"; MEND-08).
 * Minting is an ordinary authenticated call. Spending happens in the three WebSocket routes and in
 * the embed exchange, through `resolveUpgradeCaller` below.
 */

/** The addressing parameters each target reads. Anything else in a request is not part of its scope. */
const SCOPE_KEYS: Readonly<Record<UpgradeTicketTarget, ReadonlyArray<string>>> = {
  tty: ["process", "session"],
  "tty-embed": ["process", "session"],
  "tty-renew": ["process", "session"],
  "service-tunnel": ["service"],
  "keys-bridge": ["host"],
};

export const scopeOf = (
  target: UpgradeTicketTarget,
  params: Readonly<Record<string, string | null | undefined>>,
): string =>
  upgradeTicketScope(Object.fromEntries(SCOPE_KEYS[target].map((key) => [key, params[key]])));

const expiresInSeconds = Math.floor(UPGRADE_TICKET_TTL_MS / 1000);

const addressed = (request: UpgradeTicketRequest): boolean => {
  switch (request.target) {
    case "tty":
    case "tty-embed":
      // Exactly one of the two address forms, as the terminal route reads them.
      return (request.process === undefined) !== (request.session === undefined);
    case "service-tunnel":
      return request.service !== undefined && request.service !== "";
    case "keys-bridge":
      return true;
  }
};

export const UpgradeTicketsGroupLive = HttpApiBuilder.group(MendApi, "upgradeTickets", (handlers) =>
  handlers.handle("mint", ({ payload }) =>
    Effect.gen(function* () {
      if (!addressed(payload)) {
        return yield* new UpgradeTicketInvalid({
          message: `a ${payload.target} ticket needs ${SCOPE_KEYS[payload.target].join(" or ")}`,
        });
      }
      const caller = yield* CurrentUser;
      const tickets = yield* UpgradeTicketsRepo;
      // Minting authorizes nothing: the target route authorizes the ticket's account against
      // the session or service exactly as it would a header, when the ticket is spent.
      const minted = yield* tickets.mint({
        userId: caller.user.id,
        // Bound to the sign-in or device that asked: signing out, or revoking the device, ends
        // every ticket it minted, renewals included.
        credential: caller.credential ?? null,
        target: payload.target,
        scope: scopeOf(payload.target, {
          process: payload.process,
          session: payload.session,
          service: payload.service,
          host: payload.host,
        }),
      });
      return new UpgradeTicket({ ticket: minted.ticket, expiresInSeconds });
    }),
  ),
);

export const UpgradeTicketExchangeGroupLive = HttpApiBuilder.group(
  MendApi,
  "upgradeTicketExchange",
  (handlers) =>
    handlers.handle("exchange", ({ payload }) =>
      Effect.gen(function* () {
        const tickets = yield* UpgradeTicketsRepo;
        const scope = scopeOf("tty-embed", { process: payload.process, session: payload.session });
        // The page's first trade spends the ticket from its URL and is handed a renewal ticket;
        // later trades show that renewal. It is kept, not spent: a reply lost on the way back
        // would otherwise leave the page holding a dead ticket. It lives in the page's memory,
        // travels only in a body, opens this one terminal, and ends twelve hours after the app
        // minted the URL or with the credential that minted it, whichever is first.
        const first = yield* tickets.consume({
          ticket: payload.ticket,
          target: "tty-embed",
          scope,
        });
        const shown =
          first ??
          (yield* tickets.consume({
            ticket: payload.ticket,
            target: "tty-renew",
            scope,
            keep: true,
          }));
        if (shown === null) return yield* new UpgradeTicketRefused();
        const { userId, credential } = shown;
        const minted = yield* tickets.mint({ userId, credential, target: "tty", scope });
        const renew =
          first === null
            ? payload.ticket
            : (yield* tickets.mint({
                userId,
                credential,
                target: "tty-renew",
                scope,
                ttlMs: UPGRADE_RENEWAL_TTL_MS,
              })).ticket;
        return new EmbedTickets({ ticket: minted.ticket, renew, expiresInSeconds });
      }),
    ),
);

/**
 * `MEND_URL_BEARERS`: whether a session or device bearer is still read from `?token=`. `accept`
 * keeps first-party clients older than tickets working and logs every use; `refuse` answers 400.
 * `accept` is an open item of the public exposure gate.
 */
export class UrlBearers extends Context.Service<
  UrlBearers,
  { readonly mode: "accept" | "refuse" }
>()("@mend/api/UrlBearers") {}

export const UrlBearersLive: Layer.Layer<UrlBearers, Config.ConfigError> = Layer.effect(
  UrlBearers,
  Effect.gen(function* () {
    const mode = yield* Config.schema(
      Schema.Literals(["accept", "refuse"]),
      "MEND_URL_BEARERS",
    ).pipe(Config.withDefault("accept" as const));
    return { mode };
  }),
);

export interface UpgradeCaller {
  readonly userId: string;
  /** Re-checked right after the socket registers, so a removal in between still closes it. */
  readonly stillAdmitted: Effect.Effect<boolean>;
}

/**
 * Who is upgrading, or the response that refuses them. In order:
 *
 * 1. `?ticket=`: spent atomically for exactly this target and these parameters.
 * 2. an `Authorization` header or the session cookie.
 * 3. `?token=`: a long-lived bearer in a URL. Refused with 400 under `MEND_URL_BEARERS=refuse`;
 *    otherwise accepted and logged, never with its value.
 *
 * A query credential is never combined with a header one: a request that carries both is judged
 * by the ticket alone, so a stale header cannot rescue a spent ticket.
 */
export const resolveUpgradeCaller = (input: {
  readonly auth: Auth["Service"];
  readonly tickets: UpgradeTicketsRepo["Service"];
  readonly organizations: OrganizationsRepo["Service"];
  readonly urlBearers: UrlBearers["Service"];
  readonly headers: Headers;
  readonly url: URL;
  readonly target: UpgradeTicketTarget;
}): Effect.Effect<UpgradeCaller | HttpServerResponse.HttpServerResponse> =>
  Effect.gen(function* () {
    const { auth, tickets, organizations, urlBearers, headers, url, target } = input;
    const ticket = url.searchParams.get("ticket");
    if (ticket !== null) {
      // The scope is read the way the route reads its address (`get`: the first value), and a
      // repeated parameter is refused outright, so a ticket never opens a parameter it was not
      // minted for, however the query is spelled.
      const bound = [...SCOPE_KEYS[target], "ticket"];
      if (bound.some((key) => url.searchParams.getAll(key).length > 1)) {
        return HttpServerResponse.text("a repeated parameter is refused", { status: 400 });
      }
      const params = Object.fromEntries(
        SCOPE_KEYS[target].map((key) => [key, url.searchParams.get(key)]),
      );
      const spent = yield* tickets.consume({ ticket, target, scope: scopeOf(target, params) });
      if (spent === null) return HttpServerResponse.empty({ status: 401 });
      return {
        userId: spent.userId,
        // A ticket carries no session to re-read: what is re-checked is what revocation and
        // removal take away, the credential that minted it and the membership.
        stillAdmitted: Effect.all([
          tickets.credentialStands(spent.credential),
          organizations.membershipOf(spent.userId),
        ]).pipe(Effect.map(([stands, membership]) => stands && membership !== null)),
      };
    }
    const token = url.searchParams.get("token");
    if (token !== null && !headers.has("authorization")) {
      if (urlBearers.mode === "refuse") {
        return HttpServerResponse.text(
          "a bearer in the URL is refused; mint an upgrade ticket (POST /api/upgrade-tickets)",
          { status: 400 },
        );
      }
      yield* Effect.logWarning(
        "a bearer arrived in a URL; this client predates upgrade tickets",
      ).pipe(
        // The path with the bearer's value replaced: a log must never hold one.
        Effect.annotateLogs({ target, url: redactUrl(`${url.pathname}${url.search}`) }),
      );
      headers.set("authorization", `Bearer ${token}`);
    }
    const session = yield* auth.getSession(headers);
    if (Option.isNone(session)) return HttpServerResponse.empty({ status: 401 });
    return {
      userId: session.value.user.id,
      stillAdmitted: auth.getSession(headers).pipe(Effect.map(Option.isSome)),
    };
  });

export const isUpgradeCaller = (
  resolved: UpgradeCaller | HttpServerResponse.HttpServerResponse,
): resolved is UpgradeCaller => "userId" in resolved;
