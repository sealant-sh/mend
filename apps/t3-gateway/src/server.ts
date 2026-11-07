import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { serveObserved } from "@mend/network/http-observation";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

import { AssetUrlsLive } from "./assets.ts";
import { AttachmentUploadsLive } from "./attachment-uploads.ts";
import { GatewayAuthLive } from "./auth.ts";
import { GatewayConfig } from "./config.ts";
import { GatewayEnvironmentLive } from "./environment.ts";
import { findParserLayer } from "./find-parser.ts";
import { GatewayRoutesLive } from "./http.ts";
import { ProjectionsLive } from "./hub.ts";
import { MAX_IMAGE_BYTES_PER_MESSAGE } from "./images.ts";
import { MendClientLive } from "./mend-client.ts";
import { GatewayStateLive } from "./state.ts";
import { WebSocketTicketsLive } from "./tickets.ts";

/** Mend over fetch. Its own client, so nothing else's `HttpClient` can redirect Mend calls. */
export const MendClientFetchLive = MendClientLive.pipe(Layer.provide(FetchHttpClient.layer));

/**
 * The routes with every service they need, given a config and find's parser. State, tickets and
 * the Mend client are built once and shared by every route.
 */
export const GatewayAppLive = GatewayRoutesLive.pipe(
  Layer.provideMerge(AttachmentUploadsLive),
  Layer.provideMerge(AssetUrlsLive),
  Layer.provide(GatewayAuthLive),
  Layer.provide(ProjectionsLive),
  Layer.provideMerge(WebSocketTicketsLive),
  Layer.provideMerge(GatewayEnvironmentLive),
  Layer.provideMerge(MendClientFetchLive),
  Layer.provideMerge(GatewayStateLive),
);

/** The full 80 MiB image batch expands in base64; leave 1 MiB for RPC and attachment metadata. */
export const gatewayHttpServerLayer = (host: string, port: number) =>
  NodeHttpServer.layer(createServer, {
    host,
    port,
    websocket: { maxPayload: Math.ceil(MAX_IMAGE_BYTES_PER_MESSAGE / 3) * 4 + 1024 * 1024 },
  });

/** The gateway listening on the configured host and port. */
export const GatewayServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* GatewayConfig;
    return serveObserved(GatewayAppLive).pipe(
      Layer.provide(findParserLayer()),
      Layer.provide(gatewayHttpServerLayer(config.host, config.port)),
    );
  }),
);
