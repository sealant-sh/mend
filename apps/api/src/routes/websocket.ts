import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { KeysBridgeRoutes } from "./keys-bridge.ts";
import { ServiceTunnelRoutes } from "./service-tunnel.ts";
import { TtyRoutes } from "./tty.ts";

const upgradeRequired = HttpRouter.middleware((handler) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("WebSocket upgrade required", { status: 426 });
    }
    return yield* handler;
  }),
).layer;

/**
 * All API WebSocket data planes require an upgrade before doing any work.
 * The global public network policy checks its Origin before these handlers can
 * authenticate, dial a workspace, attach a PTY, or replace an agent signer.
 */
export const WebSocketRoutes = Layer.mergeAll(
  KeysBridgeRoutes,
  ServiceTunnelRoutes,
  TtyRoutes,
).pipe(Layer.provide(upgradeRequired));
