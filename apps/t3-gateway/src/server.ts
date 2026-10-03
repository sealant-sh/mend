import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { GatewayAuthLive } from "./auth.ts";
import { GatewayConfig } from "./config.ts";
import { GatewayEnvironmentLive } from "./environment.ts";
import { GatewayRoutesLive } from "./http.ts";
import { MendClientLive } from "./mend-client.ts";
import { GatewayStateLive } from "./state.ts";
import { WebSocketTicketsLive } from "./tickets.ts";

/** Mend over fetch. Its own client, so nothing else's `HttpClient` can redirect Mend calls. */
export const MendClientFetchLive = MendClientLive.pipe(Layer.provide(FetchHttpClient.layer));

/**
 * The routes with every service they need, given a config. State, tickets and the Mend client
 * are built once and shared by every route.
 */
export const GatewayAppLive = GatewayRoutesLive.pipe(
  Layer.provide(GatewayAuthLive),
  Layer.provideMerge(WebSocketTicketsLive),
  Layer.provideMerge(GatewayEnvironmentLive),
  Layer.provide(MendClientFetchLive),
  Layer.provideMerge(GatewayStateLive),
);

/** The gateway listening on the configured host and port. */
export const GatewayServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* GatewayConfig;
    return HttpRouter.serve(GatewayAppLive).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host: config.host, port: config.port })),
    );
  }),
);
