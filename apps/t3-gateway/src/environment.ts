import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
  type ServerAuthDescriptor,
} from "@mend/t3-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GatewayConfig } from "./config.ts";
import { GatewayState } from "./state.ts";
import { SERVER_VERSION } from "./version.ts";

/**
 * What the gateway tells a t3code client about itself before pairing: the environment descriptor
 * (`GET /.well-known/t3/environment`) and the auth posture inside `/api/auth/session`.
 */
export class GatewayEnvironment extends Context.Service<
  GatewayEnvironment,
  {
    readonly descriptor: ExecutionEnvironmentDescriptor;
    readonly auth: ServerAuthDescriptor;
  }
>()("@mend/t3-gateway/GatewayEnvironment") {}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(
    host
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1"),
  );

const platformOs = (platform: NodeJS.Platform): ExecutionEnvironmentDescriptor["platform"]["os"] =>
  platform === "darwin"
    ? "darwin"
    : platform === "linux"
      ? "linux"
      : platform === "win32"
        ? "windows"
        : "unknown";

const platformArch = (
  arch: NodeJS.Architecture,
): ExecutionEnvironmentDescriptor["platform"]["arch"] =>
  arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : "other";

/**
 * The bearer session cookie name t3code's descriptor requires. The gateway never sets cookies:
 * `sessionMethods` offers bearer tokens only.
 */
export const SESSION_COOKIE_NAME = "t3_mend_gateway_session";

export const makeGatewayEnvironment = (input: {
  readonly environmentId: ExecutionEnvironmentDescriptor["environmentId"];
  readonly label: string;
  readonly host: string;
}): GatewayEnvironment["Service"] => ({
  descriptor: {
    environmentId: input.environmentId,
    label: input.label,
    platform: { os: platformOs(process.platform), arch: platformArch(process.arch) },
    serverVersion: SERVER_VERSION,
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    // Every optional capability is absent: a client treats absent as unsupported and never sends
    // what it gates. Phases 1–3 switch on what Mend can back.
    capabilities: { repositoryIdentity: false },
  },
  auth: {
    policy: isLoopbackHost(input.host) ? "loopback-browser" : "remote-reachable",
    // A pairing code from Mend (`POST /api/me/devices/pairings`, or `mend t3 pair`).
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: SESSION_COOKIE_NAME,
  },
});

export const GatewayEnvironmentLive: Layer.Layer<
  GatewayEnvironment,
  never,
  GatewayConfig | GatewayState
> = Layer.effect(
  GatewayEnvironment,
  Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const state = yield* GatewayState;
    return makeGatewayEnvironment({
      environmentId: state.environmentId,
      label: config.label,
      host: config.host,
    });
  }),
);
