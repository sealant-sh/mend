import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentHttpApi } from "@mend/t3-contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";

import { AssetTracingDisabledLive, AssetUrlsLive } from "../../src/assets.ts";
import { GatewayAuthLive } from "../../src/auth.ts";
import { GatewayConfig } from "../../src/config.ts";
import { GatewayEnvironmentLive } from "../../src/environment.ts";
import { FindParser, findParserLayer } from "../../src/find-parser.ts";
import { GatewayRoutesLive } from "../../src/http.ts";
import { ProjectionsLive } from "../../src/hub.ts";
import { MendClient, type MendCommand } from "../../src/mend-client.ts";
import type { MendEventPointer } from "../../src/mend-workbench.ts";
import type { QueueTimings } from "../../src/queue.ts";
import { GatewayAppLive, MendClientFetchLive } from "../../src/server.ts";
import { GatewayStateLive } from "../../src/state.ts";
import { WebSocketTicketsLive } from "../../src/tickets.ts";

/** Observes the real launch caller fiber and the refusal its live HTTP client decoded. */
export interface LaunchObserver {
  /** Captures the calling fiber before the real HTTP launch begins. */
  readonly started: (
    sessionId: string,
    fiber: Fiber.Fiber<unknown, unknown>,
  ) => Effect.Effect<void>;
  /** Reports the typed HTTP refusal while allowing the caller to process it normally. */
  readonly failed: (
    sessionId: string,
    error: Effect.Error<MendCommand<unknown>>,
  ) => Effect.Effect<void>;
}

type ClientObservers = {
  readonly launchObserver?: LaunchObserver;
  /** Called on the next pull, after the live SSE consumer handled the previous pointer. */
  readonly eventConsumed?: (pointer: MendEventPointer) => Effect.Effect<void>;
  /** Captures a completion effect when the live HTTP device check starts. */
  readonly deviceCheckObserver?: () => Effect.Effect<void>;
};

// These observers wrap the live client without replacing its requests or decoded responses.
const gatewayWithClientObservers = (observers: ClientObservers) => {
  const { launchObserver, eventConsumed, deviceCheckObserver } = observers;
  const client = Layer.effect(
    MendClient,
    Effect.map(MendClient, (live) => ({
      ...live,
      launchProtocol: (...args: Parameters<typeof live.launchProtocol>) =>
        launchObserver === undefined
          ? live.launchProtocol(...args)
          : Effect.gen(function* () {
              const fiber = yield* Effect.fiber;
              yield* launchObserver.started(args[1], fiber);
              return yield* live
                .launchProtocol(...args)
                .pipe(Effect.tapError((error) => launchObserver.failed(args[1], error)));
            }),
      checkDevice: (token: string) =>
        deviceCheckObserver === undefined
          ? live.checkDevice(token)
          : Effect.suspend(() => {
              const completed = deviceCheckObserver();
              return live.checkDevice(token).pipe(Effect.tap(() => completed));
            }),
      events: (token: string) =>
        eventConsumed === undefined
          ? live.events(token)
          : live.events(token).pipe(Stream.rechunk(1), (stream) =>
              Stream.transformPull(stream, (pull) =>
                Effect.sync(() => {
                  let previous: MendEventPointer | null = null;
                  return Effect.gen(function* () {
                    if (previous !== null) yield* eventConsumed(previous);
                    const chunk = yield* pull;
                    previous = chunk[0];
                    return chunk;
                  });
                }),
              ),
            ),
    })),
  ).pipe(Layer.provide(MendClientFetchLive));
  return GatewayRoutesLive.pipe(
    Layer.provide(GatewayAuthLive),
    Layer.provide(ProjectionsLive),
    Layer.provideMerge(WebSocketTicketsLive),
    Layer.provideMerge(AssetUrlsLive),
    Layer.provideMerge(AssetTracingDisabledLive),
    Layer.provideMerge(GatewayEnvironmentLive),
    Layer.provideMerge(client),
    Layer.provideMerge(GatewayStateLive),
  );
};

/**
 * The gateway on an ephemeral loopback port, in front of `mendUrl`, with its state in memory
 * unless a path is given. The layer's `HttpClient` points at the gateway, so `t3Client` is what a
 * t3code client builds: `HttpApiClient` over the vendored `EnvironmentHttpApi`.
 */
export const gatewayTestLayer = (
  mendUrl: URL,
  statePath = ":memory:",
  options: ClientObservers & {
    readonly hubIdleTimeToLive?: Duration.Input;
    readonly queueTimings?: Partial<QueueTimings>;
    /**
     * Serves with the request logger on, as production does, and collects every log line (JSON)
     * here. Without it, nothing is logged.
     */
    readonly logs?: Array<string>;
    /**
     * Find's parser, to share one worker pool across gateways. Without it the gateway starts its
     * own, as production does.
     */
    readonly parser?: FindParser["Service"];
  } = {},
) =>
  HttpRouter.serve(
    options.launchObserver === undefined &&
      options.eventConsumed === undefined &&
      options.deviceCheckObserver === undefined
      ? GatewayAppLive
      : gatewayWithClientObservers(options),
    {
      disableLogger: options.logs === undefined,
      disableListenLog: true,
    },
  ).pipe(
    Layer.provide(
      options.parser === undefined ? findParserLayer() : Layer.succeed(FindParser, options.parser),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(
      options.logs === undefined ? Layer.empty : Logger.layer([collectingLogger(options.logs)]),
    ),
    Layer.provideMerge(
      Layer.succeed(GatewayConfig, {
        mendUrl,
        host: "127.0.0.1",
        port: 0,
        statePath,
        label: "Mend under test",
        ...(options.hubIdleTimeToLive === undefined
          ? {}
          : { hubIdleTimeToLive: options.hubIdleTimeToLive }),
        ...(options.queueTimings === undefined ? {} : { queueTimings: options.queueTimings }),
      }),
    ),
  );

export const t3Client = HttpApiClient.make(EnvironmentHttpApi);

/** A logger that keeps each line as `Logger.formatJson` writes it. */
const collectingLogger = (lines: Array<string>) =>
  Logger.make((options) => {
    lines.push(String(Logger.formatJson.log(options)));
  });

/** The token request a t3code client sends when it pairs (`bootstrapRemoteBearerSession`). */
export const tokenRequest = (
  credential: string,
  extra: {
    readonly scope?: string;
    readonly client_label?: string;
    readonly client_device_type?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    readonly client_os?: string;
  } = {},
) =>
  ({
    headers: {},
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      ...extra,
    },
  }) as const;

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export const PERSON = { id: "user-1", name: "Ada", email: "ada@example.com" } as const;

export const pairedClient = (code: string) =>
  Effect.gen(function* () {
    const client = yield* t3Client;
    const access = yield* client.auth.token(tokenRequest(code, { client_device_type: "desktop" }));
    return { client, access };
  });
