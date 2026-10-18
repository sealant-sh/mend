import { isAllowedOrigin, type PublicNetwork } from "@mend/network";
import { Effect, type Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { publicNetworkCors } from "./public-network-cors.ts";

/**
 * Reject unsafe browser requests before routing or upgrading, then apply CORS.
 * Cookie-bearing writes/upgrades require an exact configured Origin. Origin-less
 * native token clients still reach authentication; a token never overrides an
 * explicitly unlisted Origin. Host and forwarding headers confer no trust.
 * Install on the router, not serve.middleware, which wraps response transmission.
 */
export const publicNetworkPolicy = (
  network: PublicNetwork,
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.middleware(
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
          return yield* handler;
        }),
      ),
    { global: true },
  );
