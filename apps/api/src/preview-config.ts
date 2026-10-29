import { isIP } from "node:net";

import {
  DEFAULT_TAILNET_PREVIEW_PORTS,
  NetworkConfig,
  previewDomainOverlap,
  type PublicNetwork,
  readPreviewPorts,
  SAME_SITE_PREVIEW_REASON,
  writePreviewPorts,
} from "@mend/network";
import { Config, Duration, Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

import {
  PREVIEW_GATEWAY_DEFAULTS,
  type PreviewBodyCap,
  type PreviewGatewaySettings,
} from "./preview-gateway-settings.ts";
import type { PreviewRouting } from "./preview-routing.ts";

const PREVIEW_VARIABLES = [
  "bind",
  "port",
  "domain",
  "publicPort",
  "startHold",
  "bodyBytes",
  "tailnetHostname",
  "tailnetPorts",
] as const;

export type PreviewVariable = (typeof PREVIEW_VARIABLES)[number];

export const PREVIEW_ENV = {
  bind: "MEND_PREVIEW_BIND",
  port: "MEND_PREVIEW_PORT",
  domain: "MEND_PREVIEW_DOMAIN",
  publicPort: "MEND_PREVIEW_PUBLIC_PORT",
  startHold: "MEND_PREVIEW_START_HOLD",
  bodyBytes: "MEND_PREVIEW_BODY_BYTES",
  tailnetHostname: "MEND_PREVIEW_TAILNET_HOSTNAME",
  tailnetPorts: "MEND_PREVIEW_TAILNET_PORTS",
} as const satisfies Record<PreviewVariable, string>;

export type PreviewEnvironment = Partial<Record<PreviewVariable, string>>;

export type PreviewSetup =
  | { readonly _tag: "Off" }
  | {
      readonly _tag: "On";
      readonly routing: PreviewRouting;
      readonly gateway: Omit<PreviewGatewaySettings, "trustedProxies">;
    };

export class PreviewConfigRefused extends Schema.TaggedError<PreviewConfigRefused>()(
  "PreviewConfigRefused",
  { variable: Schema.String, message: Schema.String },
) {}

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PUBLIC_PORT = 443;
const MIN_START_HOLD_MS = 1_000;

const refuse = (variable: PreviewVariable, problem: string) =>
  Effect.fail(
    new PreviewConfigRefused({
      variable: PREVIEW_ENV[variable],
      message: `${PREVIEW_ENV[variable]}: ${problem}`,
    }),
  );

const portOf = (variable: PreviewVariable, raw: string) => {
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  return port >= 1 && port <= 65_535
    ? Effect.succeed(port)
    : refuse(variable, `"${raw}" is not a TCP port (1 to 65535)`);
};

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase DNS name whose last label is not a number, so never an IP address. */
const dnsNameOf = (variable: PreviewVariable, raw: string) => {
  const labels = raw.split(".");
  const named =
    raw.length <= 253 &&
    labels.every((label) => DNS_LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels.at(-1) ?? "");
  return named
    ? Effect.succeed(raw)
    : refuse(variable, `"${raw}" is not a lowercase DNS name, such as previews.example.net`);
};

const hostsOf = (mend: PublicNetwork) =>
  mend.allowedOrigins.map((origin) => ({ origin, host: new URL(origin).hostname }));

const apartFromMend = (domain: string, mend: PublicNetwork) => {
  for (const { origin, host } of hostsOf(mend)) {
    const overlap = previewDomainOverlap(domain, host);
    if (overlap === null) continue;
    switch (overlap.kind) {
      case "holds":
        return refuse(
          "domain",
          `"${domain}" holds Mend's own origin ${origin} (APP_URL or MEND_ALLOWED_ORIGINS); previews need a domain apart from Mend's`,
        );
      case "under":
        return refuse(
          "domain",
          `"${domain}" is under Mend's own host ${host} (${origin}); previews need a domain apart from Mend's`,
        );
      case "same-site":
        return refuse(
          "domain",
          `"${domain}" shares the registrable domain ${overlap.site} with Mend's own origin ${origin} (APP_URL or MEND_ALLOWED_ORIGINS), so a page on a preview can set cookies Mend's host receives. ${SAME_SITE_PREVIEW_REASON}`,
        );
    }
  }
  return Effect.void;
};

const tailnetPortsOf = (raw: string) => {
  const read = readPreviewPorts(raw);
  return read._tag === "Ports" ? Effect.succeed(read.ports) : refuse("tailnetPorts", read.problem);
};

const decodeDuration = Schema.decodeUnknownOption(Schema.DurationFromString);

const startHoldOf = (raw: string) => {
  const ms = Option.match(decodeDuration(raw), {
    onNone: () => Number.NaN,
    onSome: Duration.toMillis,
  });
  return Number.isSafeInteger(ms) && ms >= MIN_START_HOLD_MS
    ? Effect.succeed(ms)
    : refuse(
        "startHold",
        `"${raw}" is not a duration of at least 1 second, such as "3 minutes" or "90 seconds"`,
      );
};

const bodyCapOf = (raw: string): Effect.Effect<PreviewBodyCap, PreviewConfigRefused> => {
  const bytes = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(bytes) && bytes > 0
    ? Effect.succeed({ _tag: "Capped", bytes })
    : refuse("bodyBytes", `"${raw}" is not a positive number of bytes`);
};

/**
 * The preview setup `env` describes, checked against Mend's own origins. Nothing set: previews are
 * off. A listen port alone: loopback, `http://<label>.localhost:<port>`. A domain: one host per
 * preview behind an edge on `MEND_PREVIEW_PUBLIC_PORT`. A tailnet hostname: a port per preview on
 * that name, from `MEND_PREVIEW_TAILNET_PORTS` or the default set. A domain takes over from a
 * tailnet hostname (decision 6).
 */
export const previewSetupOf = (
  env: PreviewEnvironment,
  mend: PublicNetwork,
): Effect.Effect<PreviewSetup, PreviewConfigRefused> =>
  Effect.gen(function* () {
    const value = (variable: PreviewVariable): string | undefined => {
      const trimmed = env[variable]?.trim() ?? "";
      return trimmed === "" ? undefined : trimmed;
    };
    if (PREVIEW_VARIABLES.every((variable) => value(variable) === undefined)) {
      return { _tag: "Off" };
    }

    const rawPort = value("port");
    if (rawPort === undefined) {
      return yield* refuse(
        "port",
        "the gateway's listen port is required once any MEND_PREVIEW_ variable is set",
      );
    }
    const port = yield* portOf("port", rawPort);
    const bind = value("bind") ?? DEFAULT_BIND;
    if (isIP(bind) === 0 && bind !== "localhost") {
      return yield* refuse("bind", `"${bind}" is not an IP address to listen on`);
    }
    const rawHold = value("startHold");
    const startHoldMs =
      rawHold === undefined ? PREVIEW_GATEWAY_DEFAULTS.startHoldMs : yield* startHoldOf(rawHold);
    const rawCap = value("bodyBytes");
    const bodyCap =
      rawCap === undefined ? PREVIEW_GATEWAY_DEFAULTS.bodyCap : yield* bodyCapOf(rawCap);

    const rawDomain = value("domain");
    const domain = rawDomain === undefined ? null : yield* dnsNameOf("domain", rawDomain);
    const rawPublicPort = value("publicPort");
    if (rawPublicPort !== undefined && domain === null) {
      return yield* refuse(
        "publicPort",
        "applies only with MEND_PREVIEW_DOMAIN; on loopback and a tailnet the browser's port is not configured here",
      );
    }
    const publicPort =
      rawPublicPort === undefined
        ? DEFAULT_PUBLIC_PORT
        : yield* portOf("publicPort", rawPublicPort);

    const rawHostname = value("tailnetHostname");
    const rawPorts = value("tailnetPorts");
    if (rawPorts !== undefined && rawHostname === undefined) {
      return yield* refuse("tailnetHostname", "is required with MEND_PREVIEW_TAILNET_PORTS");
    }
    const tailnet =
      rawHostname === undefined
        ? null
        : {
            hostname: yield* dnsNameOf("tailnetHostname", rawHostname),
            ports: yield* tailnetPortsOf(rawPorts ?? DEFAULT_TAILNET_PREVIEW_PORTS),
          };
    if (tailnet !== null) {
      const own = hostsOf(mend).find(({ host }) => host === tailnet.hostname);
      if (own !== undefined) {
        return yield* refuse(
          "tailnetHostname",
          `"${tailnet.hostname}" is Mend's own host (${own.origin}); the gateway needs a name of its own, such as a Tailscale Service`,
        );
      }
    }
    if (domain !== null) yield* apartFromMend(domain, mend);

    const routing: PreviewRouting =
      domain !== null
        ? { mode: "domain-https", domain, port: publicPort }
        : tailnet !== null
          ? { mode: "tailnet-https", hostname: tailnet.hostname, ports: tailnet.ports }
          : { mode: "loopback-http", port };
    return {
      _tag: "On",
      routing,
      gateway: {
        bind,
        port,
        startHoldMs,
        bodyCap,
        limits: PREVIEW_GATEWAY_DEFAULTS.limits,
        queueWaitMs: PREVIEW_GATEWAY_DEFAULTS.queueWaitMs,
      },
    };
  });

const variableConfig = (name: string) => Config.String(name).pipe(Config.withDefault(""));

export const loadPreviewSetup: Effect.Effect<
  PreviewSetup,
  PreviewConfigRefused | Config.ConfigError,
  NetworkConfig
> = Effect.gen(function* () {
  const mend = yield* NetworkConfig;
  const env = yield* Config.all({
    bind: variableConfig(PREVIEW_ENV.bind),
    port: variableConfig(PREVIEW_ENV.port),
    domain: variableConfig(PREVIEW_ENV.domain),
    publicPort: variableConfig(PREVIEW_ENV.publicPort),
    startHold: variableConfig(PREVIEW_ENV.startHold),
    bodyBytes: variableConfig(PREVIEW_ENV.bodyBytes),
    tailnetHostname: variableConfig(PREVIEW_ENV.tailnetHostname),
    tailnetPorts: variableConfig(PREVIEW_ENV.tailnetPorts),
  });
  const setup = yield* previewSetupOf(env, mend);
  yield* Effect.logInfo("previews").pipe(
    Effect.annotateLogs(
      setup._tag === "Off"
        ? { gateway: "off" }
        : {
            gateway: `${setup.gateway.bind}:${setup.gateway.port}`,
            routing: setup.routing.mode,
            ...(setup.routing.mode === "tailnet-https"
              ? { tailnetPorts: writePreviewPorts(setup.routing.ports) }
              : {}),
            startHoldMs: setup.gateway.startHoldMs,
          },
    ),
  );
  return setup;
});

export class PreviewSetupConfig extends Context.Service<
  PreviewSetupConfig,
  { readonly setup: PreviewSetup }
>()("@mend/api/PreviewSetupConfig") {}

export const PreviewSetupConfigLive: Layer.Layer<
  PreviewSetupConfig,
  PreviewConfigRefused | Config.ConfigError,
  NetworkConfig
> = Layer.effect(
  PreviewSetupConfig,
  Effect.map(loadPreviewSetup, (setup) => ({ setup })),
);
