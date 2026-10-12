import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentHttpApi } from "@mend/t3-contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { AssetTracingDisabledLive, AssetUrlsLive } from "../../src/assets.ts";
import { GatewayAuthLive } from "../../src/auth.ts";
import { GatewayConfig } from "../../src/config.ts";
import { GatewayEnvironmentLive } from "../../src/environment.ts";
import { GatewayRoutesLive } from "../../src/http.ts";
import { ProjectionsLive } from "../../src/hub.ts";
import { MendClient, type MendCommand } from "../../src/mend-client.ts";
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

// Only the observed launch case uses this composition. Every dependency remains its live
// implementation; the wrapper captures the whole caller fiber, not a child HTTP fiber.
const gatewayWithLaunchObserver = (observer: LaunchObserver) => {
  const client = Layer.effect(
    MendClient,
    Effect.map(MendClient, (live) => ({
      ...live,
      launchProtocol: (...args: Parameters<typeof live.launchProtocol>) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.fiber;
          yield* observer.started(args[1], fiber);
          return yield* live
            .launchProtocol(...args)
            .pipe(Effect.tapError((error) => observer.failed(args[1], error)));
        }),
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
  options: {
    readonly hubIdleTimeToLive?: Duration.Input;
    readonly queueTimings?: Partial<QueueTimings>;
    /** Uses the same live dependencies with a client observer for one launch completion test. */
    readonly launchObserver?: LaunchObserver;
    /**
     * Serves with the request logger on, as production does, and collects every log line (JSON)
     * here. Without it, nothing is logged.
     */
    readonly logs?: Array<string>;
  } = {},
) =>
  HttpRouter.serve(
    options.launchObserver === undefined
      ? GatewayAppLive
      : gatewayWithLaunchObserver(options.launchObserver),
    {
      disableLogger: options.logs === undefined,
      disableListenLog: true,
    },
  ).pipe(
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
