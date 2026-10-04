import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvironmentHttpApi } from "@mend/t3-contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { GatewayConfig } from "../../src/config.ts";
import { GatewayAppLive } from "../../src/server.ts";

/**
 * The gateway on an ephemeral loopback port, in front of `mendUrl`, with its state in memory
 * unless a path is given. The layer's `HttpClient` points at the gateway, so `t3Client` is what a
 * t3code client builds: `HttpApiClient` over the vendored `EnvironmentHttpApi`.
 */
export const gatewayTestLayer = (
  mendUrl: URL,
  statePath = ":memory:",
  options: { readonly hubIdleTimeToLive?: Duration.Input } = {},
) =>
  HttpRouter.serve(GatewayAppLive, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
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
      }),
    ),
  );

export const t3Client = HttpApiClient.make(EnvironmentHttpApi);

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
