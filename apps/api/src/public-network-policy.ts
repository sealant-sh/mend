import {
  cookieValues,
  isAllowedOrigin,
  type PublicNetwork,
  sessionCookieName,
  SIBLING_SITE_REFUSAL,
  siblingSiteRefused,
} from "@mend/network";
import { Effect, type Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { publicNetworkCors } from "./public-network-cors.ts";

/**
 * Reject unsafe browser requests before routing or upgrading, then apply CORS.
 * Cookie-bearing writes/upgrades require an exact configured Origin, and a request carrying Mend's
 * session cookie from another site or a sibling host is refused unless it names one or is a
 * top-level navigation (`siblingSiteRefused`). Origin-less native token clients still reach
 * authentication; a token never overrides an explicitly unlisted Origin. Host and forwarding
 * headers confer no trust.
 * Install on the router, not serve.middleware, which wraps response transmission.
 */
export const publicNetworkPolicy = (
  network: PublicNetwork,
): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const sessionCookie = sessionCookieName(network.appUrl);
  return HttpRouter.middleware(
    (handler) =>
      publicNetworkCors(network)(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const protectedRequest =
            !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
            request.headers["upgrade"] !== undefined;
          const origin = request.headers["origin"];
          if (
            protectedRequest &&
            (origin === undefined
              ? request.headers["cookie"] !== undefined
              : !isAllowedOrigin(network, origin))
          ) {
            return HttpServerResponse.text("Origin not allowed", { status: 403 });
          }
          if (
            siblingSiteRefused(network, {
              method: request.method,
              upgrade: request.headers["upgrade"] !== undefined,
              origin,
              sessionCookie: cookieValues(request.headers["cookie"], sessionCookie).length > 0,
              fetchSite: request.headers["sec-fetch-site"],
              fetchMode: request.headers["sec-fetch-mode"],
              fetchDest: request.headers["sec-fetch-dest"],
            })
          ) {
            return HttpServerResponse.text(SIBLING_SITE_REFUSAL, { status: 403 });
          }
          return yield* handler;
        }),
      ),
    { global: true },
  );
};
