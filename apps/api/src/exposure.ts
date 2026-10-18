import { sessionCookiePolicy } from "@mend/auth";
import { NetworkConfig, trustedProxyCidrs, trustsEveryAddress } from "@mend/network";
import { DeploymentConfig } from "@mend/store";
import { Config, Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

import { budgetEnvName, Budgets, budgetsOff, type BudgetName } from "./budgets.ts";
import { ErrorDetail } from "./error-boundary.ts";
import { UrlBearers } from "./routes/upgrade-tickets.ts";
import { TenancyConfig, type GateOutcome } from "./tenancy.ts";

/**
 * `MEND_EXPOSURE` and the public exposure gate (docs/adr/0004-access-without-a-private-network.md,
 * "Exposure is declared, and reported as observed" and "Public exposure gate").
 *
 * - `loopback`: reached from this machine only.
 * - `private` (the default): reached over a network the operator controls admission to (a tailnet,
 *   a LAN, a VPN).
 * - `public`: reachable from the Internet.
 *
 * The declaration is the operator's statement. This process cannot observe who can reach it: a
 * container does not know what is published in front of it. So it reports what it can observe
 * beside what was declared, and never a verdict.
 */
export const Exposure = Schema.Literals(["loopback", "private", "public"]);
export type Exposure = typeof Exposure.Type;

/**
 * How an item was established. `observed`: this process read it, in effect, on this instance.
 * `carried`: this build contains it, and this process cannot see it in effect (it lives in another
 * tier, or it is behaviour rather than configuration); what would observe it is stated. `declared`:
 * the operator stated it and this process cannot check it. `open`: none of those.
 */
export type Established = "observed" | "carried" | "declared" | "open";

/**
 * The items no build can observe from inside the deployment. An operator who verified one from
 * outside states so in `MEND_EXPOSURE_DECLARED`; nothing else can close them. `workspace-ssh` is
 * declarable only in that sense: who reaches a published SSH port is never visible from in here.
 */
export const DECLARABLE = ["core-private", "edge-tls", "workspace-ssh", "t3code-gateway"] as const;
export type Declarable = (typeof DECLARABLE)[number];

export interface ExposureOutcome {
  readonly id: string;
  readonly established: Established;
  /** What was observed or declared, in plain words. */
  readonly detail: string;
  /** What would close it, when it is open. For an item no build can observe: what would verify it. */
  readonly fix: string | null;
  /**
   * Whether an open item refuses a `public` start. Items no build can observe never do, with one
   * exception: `workspace-ssh`, which no build can observe either, waits for the operator's
   * statement because the operator chose to publish the port.
   */
  readonly blocksStart: boolean;
  /**
   * Whether this process can establish the item itself: read it in effect, here. False for what
   * only a look from outside or the operator's word can settle. What the summaries count as
   * observable; never inferred from `blocksStart`.
   */
  readonly observable: boolean;
}

export class ExposureConfig extends Context.Service<
  ExposureConfig,
  {
    readonly exposure: Exposure;
    /**
     * The public exposure gate as it stands now, whatever was declared: configuration as read at
     * start, the multi mode gate items as they are on each read (`TenancyConfig.gate`).
     */
    readonly gate: Effect.Effect<ReadonlyArray<ExposureOutcome>>;
    /** The same gate over a multi mode gate already read, so one request reads it once. */
    readonly gateWith: (tenancyGate: ReadonlyArray<GateOutcome>) => ReadonlyArray<ExposureOutcome>;
    /** The t3code gateway as configured, when it is enabled: what `/api/machine` reports. */
    readonly t3Gateway: T3GatewayFacts | undefined;
  }
>()("@mend/api/ExposureConfig") {}

/**
 * The t3code gateway as the deployment configured it (ADR 0012): what a T3 Code client enters in
 * its Remote link (`MEND_T3_GATEWAY_URL`), and where its port is published
 * (`MEND_T3_GATEWAY_PUBLISHED`, `<address>:<port>`). Both are statements of configuration that
 * `mend server setup` writes; neither is observed here. Null when it was not said.
 */
export interface T3GatewayFacts {
  readonly url: string | null;
  readonly published: string | null;
}

export class ExposureRefused extends Schema.TaggedError<ExposureRefused>()("ExposureRefused", {
  message: Schema.String,
}) {}

/** The facts the gate reads. Everything here is configuration or something the build carries. */
export interface ExposurePosture {
  readonly appUrl: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly trustedProxies: ReadonlyArray<string>;
  readonly tenancyGate: ReadonlyArray<GateOutcome>;
  readonly budgetsOff: ReadonlyArray<BudgetName>;
  readonly urlBearers: "accept" | "refuse";
  readonly errorDetail: "redacted" | "verbose";
  /** The session channel URL workspaces are given, when it is a network endpoint. */
  readonly sessionChannelUrl: string | undefined;
  /**
   * `MEND_EXECUTOR_NETWORK=private`: the operator states executors reach the channel privately.
   * What the engine sends the daemon as `transport.plaintext`; here, what the gate reports.
   */
  readonly executorNetwork: "private" | undefined;
  /**
   * `MEND_SSH_PUBLISHED`: where the workspace SSH gateway is published apart from the web port
   * (`mend server setup --ssh-bind`), as `<address>:<port>`; undefined when it is not.
   */
  readonly sshPublished: string | undefined;
  /** `MEND_EXPOSURE_DECLARED`: the unobservable items the operator states they verified. */
  readonly declared: ReadonlyArray<Declarable>;
  /** `MEND_EXPOSURE_REASSESSED`: the version the operator recorded a reassessment of. */
  readonly reassessedVersion: string | undefined;
  /**
   * `MEND_T3_GATEWAY_ENABLED`: the t3code gateway is enabled beside Mend, on a port of its own
   * (ADR 0012). A configuration fact, read once: whether it listens is not observed here. Absent
   * or false, the gate lists nothing about it.
   */
  readonly t3Gateway?: boolean;
  /** `MEND_T3_GATEWAY_PUBLISHED`: where the gateway's port is published, `<address>:<port>`. */
  readonly t3GatewayPublished?: string;
  /** `MEND_T3_GATEWAY_URL`: what a T3 Code client enters; `https:` when an edge serves it. */
  readonly t3GatewayUrl?: string;
  readonly version: string;
  /**
   * The package and image mirrors sessions are pointed at (`MEND_NPM_MIRROR_URL`,
   * `SEALANT_DOCKER_REGISTRY_MIRRORS`), by host and port. They publish no port of their own: like
   * Sealant and the database they sit on the deployment's network, so `core-private` names them.
   */
  readonly mirrors?: ReadonlyArray<string>;
}

const observed = (id: string, ok: boolean, detail: string, fix: string): ExposureOutcome => ({
  id,
  established: ok ? "observed" : "open",
  detail,
  fix: ok ? null : fix,
  blocksStart: true,
  observable: true,
});

/** In this build, and not something this process can see in effect. `verify` says what would. */
const carried = (id: string, detail: string, verify: string): ExposureOutcome => ({
  id,
  established: "carried",
  detail,
  fix: `what would observe it: ${verify}`,
  blocksStart: false,
  observable: false,
});

/** Something only a look from outside can establish: open until the operator states they looked. */
const unobservable = (
  posture: ExposurePosture,
  id: Declarable,
  cannot: string,
  stated: string,
  verify: string,
): ExposureOutcome =>
  posture.declared.includes(id)
    ? {
        id,
        established: "declared",
        detail: `${stated} (MEND_EXPOSURE_DECLARED); this process cannot check it`,
        fix: null,
        blocksStart: false,
        observable: false,
      }
    : {
        id,
        established: "open",
        detail: cannot,
        fix: `what would verify it: ${verify}; then add ${id} to MEND_EXPOSURE_DECLARED`,
        blocksStart: false,
        observable: false,
      };

/** A build with no version of its own: nothing a reassessment could name. */
const UNVERSIONED = "dev";

const isHttps = (origin: string): boolean => origin.startsWith("https://");

/** The address part of `<address>:<port>`, IPv6 brackets removed. */
const publishedAddress = (published: string): string =>
  published.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

const isLoopbackAddress = (address: string): boolean =>
  address === "::1" || address === "localhost" || address.startsWith("127.");

/**
 * The workspace SSH gateway published apart from the web port. An edge carries HTTPS only, so a
 * published SSH port is a second way in, beside it: the gateway admits registered keys only, and a
 * workspace only for its launcher, but who can reach the port is a fact of the network this process
 * cannot see. On loopback (or not published apart) there is nothing to state. Anywhere else it is
 * open until the operator states, having looked from outside, who reaches it; a `public` start
 * waits for that statement.
 */
const workspaceSsh = (posture: ExposurePosture): ExposureOutcome => {
  const published = posture.sshPublished;
  if (published === undefined) {
    return observed(
      "workspace-ssh",
      true,
      "workspace SSH is not published apart from the web port (MEND_SSH_PUBLISHED unset)",
      "",
    );
  }
  if (isLoopbackAddress(publishedAddress(published))) {
    return observed("workspace-ssh", true, `workspace SSH is published on ${published} only`, "");
  }
  return posture.declared.includes("workspace-ssh")
    ? {
        id: "workspace-ssh",
        established: "declared",
        detail: `workspace SSH is published on ${published} apart from the web port, and the operator states who can reach it (MEND_EXPOSURE_DECLARED); this process cannot check it`,
        fix: null,
        blocksStart: true,
        observable: false,
      }
    : {
        id: "workspace-ssh",
        established: "open",
        detail: `workspace SSH is published on ${published} apart from the web port; this process cannot observe who can reach it`,
        fix: `what would verify it: a connection attempt to ${published} from each network that should not reach it; then add workspace-ssh to MEND_EXPOSURE_DECLARED, or publish it on loopback`,
        blocksStart: true,
        observable: false,
      };
};

/**
 * The t3code gateway, while it is enabled (ADR 0012): a listener of its own beside the web port.
 * Every device pairs through Mend, so who may use it is Mend's rule; who can reach it is a fact of
 * the network. Published on loopback, there is nothing to state. Published beyond it (where a
 * private install's web port is), it is open until the operator states who reaches it, as
 * `workspace-ssh` is, and a `public` start waits for that. Served by the edge on an origin of its
 * own, its certificate is the operator's to verify, as `edge-tls` is. Not said where it is
 * published (a deployment `mend server setup` did not write), only a look from outside tells.
 */
const t3codeGateway = (posture: ExposurePosture): ExposureOutcome => {
  const published = posture.t3GatewayPublished;
  const url = posture.t3GatewayUrl;
  if (published === undefined) {
    return unobservable(
      posture,
      "t3code-gateway",
      "the t3code gateway is enabled (MEND_T3_GATEWAY_ENABLED), on a port of its own; where it is published was not said (MEND_T3_GATEWAY_PUBLISHED unset), and this process cannot observe who reaches it, nor whether it is listening",
      "the operator states who reaches the t3code gateway's port",
      "a connection attempt to its port from each network that should not reach it",
    );
  }
  const onLoopback = isLoopbackAddress(publishedAddress(published));
  if (onLoopback && url !== undefined && isHttps(url)) {
    return unobservable(
      posture,
      "t3code-gateway",
      `the t3code gateway's port is published on ${published} only (MEND_T3_GATEWAY_PUBLISHED), and the edge serves it at ${url} (MEND_T3_GATEWAY_URL); this process cannot observe that origin's certificate`,
      `the operator states ${url} serves the t3code gateway with a certificate that chains to a public root`,
      `${url}/.well-known/t3/environment from another network, over a certificate that chains to a public root, and ${published} answering nothing from another machine`,
    );
  }
  if (onLoopback) {
    return observed(
      "t3code-gateway",
      true,
      `the t3code gateway's port is published on ${published} only (MEND_T3_GATEWAY_PUBLISHED)`,
      "",
    );
  }
  return posture.declared.includes("t3code-gateway")
    ? {
        id: "t3code-gateway",
        established: "declared",
        detail: `the t3code gateway's port is published on ${published} (MEND_T3_GATEWAY_PUBLISHED), and the operator states who can reach it (MEND_EXPOSURE_DECLARED); this process cannot check it`,
        fix: null,
        blocksStart: true,
        observable: false,
      }
    : {
        id: "t3code-gateway",
        established: "open",
        detail: `the t3code gateway's port is published on ${published} (MEND_T3_GATEWAY_PUBLISHED); every device pairs through Mend, and this process cannot observe who can reach the port`,
        fix: `what would verify it: a connection attempt to ${published} from each network that should not reach it; then add t3code-gateway to MEND_EXPOSURE_DECLARED, or publish it on loopback`,
        blocksStart: true,
        observable: false,
      };
};

export const evaluateExposureGate = (posture: ExposurePosture): ReadonlyArray<ExposureOutcome> => {
  const plainOrigins = posture.allowedOrigins.filter((origin) => !isHttps(origin));
  const cookie = sessionCookiePolicy({ appUrl: posture.appUrl });
  // All of them, `operator-present` included: until the first account exists, registration is
  // open to whoever arrives first, and on the Internet that is not the owner. Create the first
  // account over a private path, then declare `public`.
  const openTenancy = posture.tenancyGate
    .filter((outcome) => !outcome.ok)
    .map((outcome) => outcome.id);
  const channelIsHttps =
    posture.sessionChannelUrl !== undefined && isHttps(posture.sessionChannelUrl);
  const reassessed =
    posture.version !== UNVERSIONED && posture.reassessedVersion === posture.version;

  return [
    observed(
      "https-origin",
      plainOrigins.length === 0,
      plainOrigins.length === 0
        ? `every browser origin is https (${posture.allowedOrigins.length})`
        : `plain http origin(s): ${plainOrigins.join(", ")}`,
      "set APP_URL and every MEND_ALLOWED_ORIGINS entry to https",
    ),
    observed(
      "secure-cookies",
      cookie.secure,
      cookie.secure
        ? "session cookies are Secure, HttpOnly and SameSite=Lax"
        : "session cookies are HttpOnly and SameSite=Lax, and not Secure: APP_URL is http",
      "set APP_URL to https",
    ),
    observed(
      "trusted-proxies",
      posture.trustedProxies.length > 0 && !trustsEveryAddress(posture.trustedProxies),
      posture.trustedProxies.length === 0
        ? "MEND_TRUSTED_PROXIES is unset: every client behind the edge counts as one address"
        : trustsEveryAddress(posture.trustedProxies)
          ? "MEND_TRUSTED_PROXIES trusts every address: a client can choose the address it is counted by"
          : `${posture.trustedProxies.length} trusted proxy range(s)`,
      "set MEND_TRUSTED_PROXIES to the ranges of the edge and the web tier, and nothing wider",
    ),
    carried(
      "enrollment-closed",
      "this build closes registration after the first account; everyone else joins by invitation",
      "a sign-up without an invitation, from outside, answering a refusal",
    ),
    observed(
      "tenancy-gate",
      openTenancy.length === 0,
      openTenancy.length === 0
        ? "every multi mode gate item this build observes is closed"
        : `open multi mode gate item(s): ${openTenancy.join(", ")}`,
      "close them: mend operator gate",
    ),
    observed(
      "budgets",
      posture.budgetsOff.length === 0,
      posture.budgetsOff.length === 0
        ? "every budget is set"
        : `budget(s) off: ${posture.budgetsOff.map(budgetEnvName).join(", ")}`,
      "unset them, or set each to a positive number (docs/operations/budgets.md)",
    ),
    observed(
      "no-bearers-in-urls",
      posture.urlBearers === "refuse",
      posture.urlBearers === "refuse"
        ? "a bearer in a URL is refused; sockets take upgrade tickets"
        : "a bearer in a URL is still accepted, for clients older than upgrade tickets",
      "set MEND_URL_BEARERS=refuse once every client sends tickets",
    ),
    carried(
      "browser-headers",
      "this build's web tier sets the browser header policy; the API cannot see the web tier that is actually in front of it",
      "mend doctor against the public origin, which reads the headers a browser receives",
    ),
    observed(
      "error-redaction",
      posture.errorDetail === "redacted",
      posture.errorDetail === "redacted"
        ? "error responses are scrubbed of upstream detail"
        : "MEND_ERROR_DETAIL=verbose: error responses carry upstream detail",
      "unset MEND_ERROR_DETAIL",
    ),
    ((): ExposureOutcome => {
      if (posture.sessionChannelUrl === undefined) {
        return observed(
          "executor-channel-transport",
          true,
          "workspaces reach their session over a mounted socket, not a network",
          "",
        );
      }
      if (channelIsHttps) {
        return observed(
          "executor-channel-transport",
          true,
          "the session channel is advertised over https",
          "",
        );
      }
      return posture.executorNetwork === "private"
        ? {
            id: "executor-channel-transport",
            established: "declared",
            detail:
              "the session channel is plain http, and the operator declared the executor network private (MEND_EXECUTOR_NETWORK=private)",
            fix: null,
            blocksStart: true,
            observable: true,
          }
        : observed(
            "executor-channel-transport",
            false,
            "the session channel is advertised over plain http",
            "serve the session channel over https, or set MEND_EXECUTOR_NETWORK=private when executors reach it over a private network",
          );
    })(),
    workspaceSsh(posture),
    ((): ExposureOutcome => {
      const mirrors = posture.mirrors ?? [];
      const services =
        mirrors.length === 0
          ? "Sealant, its registry and the database"
          : `Sealant, its registry, the database and the package mirrors (${mirrors.join(", ")})`;
      return unobservable(
        posture,
        "core-private",
        `this process cannot observe whether ${services} are reachable from the Internet`,
        `the operator states ${services} are not reachable from the Internet`,
        "a connection attempt to each from outside the deployment's network",
      );
    })(),
    unobservable(
      posture,
      "edge-tls",
      "this process cannot observe the edge's certificate, its renewal, or its port 80 redirect",
      "the operator states the edge's certificate chains to a public root, renews, and port 80 redirects",
      "mend doctor run against the origin from another network",
    ),
    // Only while the gateway is enabled: an install that never turns it on reads as before it.
    ...(posture.t3Gateway === true ? [t3codeGateway(posture)] : []),
    {
      id: "reassessment",
      established: reassessed ? "declared" : "open",
      detail: reassessed
        ? `the operator recorded an independent reassessment of ${posture.version}`
        : posture.version === UNVERSIONED
          ? "this build has no version, so no reassessment can name it"
          : posture.reassessedVersion === undefined
            ? `no independent reassessment of ${posture.version} is recorded`
            : `a reassessment of ${posture.reassessedVersion} is recorded; this is ${posture.version}`,
      fix: reassessed
        ? null
        : posture.version === UNVERSIONED
          ? "run a released build"
          : `after an independent security reassessment of this exact release, set MEND_EXPOSURE_REASSESSED=${posture.version}`,
      blocksStart: false,
      observable: false,
    },
  ];
};

/**
 * Nothing is open: every item was observed, is carried by this build, or was declared by the
 * operator. That is a statement about this list, never that the instance is fit to expose.
 */
export const exposureGatePasses = (gate: ReadonlyArray<ExposureOutcome>): boolean =>
  gate.every((outcome) => outcome.established !== "open");

/** Why this declaration must not start, or null when it may. Only `public` is ever refused. */
export const exposureRefusal = (
  exposure: Exposure,
  gate: ReadonlyArray<ExposureOutcome>,
): string | null => {
  if (exposure !== "public") return null;
  const blocking = gate.filter((outcome) => outcome.blocksStart && outcome.established === "open");
  if (blocking.length === 0) return null;
  return [
    "MEND_EXPOSURE=public is refused: the public exposure gate",
    "(docs/adr/0004-access-without-a-private-network.md, 'Public exposure gate') has open items that refuse a public start.",
    ...blocking.map((outcome) => `\n  ${outcome.id}: ${outcome.detail} (${outcome.fix ?? ""})`),
    "\nStart with MEND_EXPOSURE=private behind a network you control admission to, or close them.",
  ].join(" ");
};

/** A variable's trimmed value; undefined when unset or empty. */
const optionalString = (name: string) =>
  Config.String(name).pipe(
    Config.map((value) => value.trim()),
    Config.option,
    Effect.map((value) => Option.getOrUndefined(Option.filter(value, (text) => text !== ""))),
  );

export const ExposureConfigLive: Layer.Layer<
  ExposureConfig,
  ExposureRefused | Config.ConfigError,
  NetworkConfig | TenancyConfig | Budgets | UrlBearers | ErrorDetail | DeploymentConfig
> = Layer.effect(
  ExposureConfig,
  Effect.gen(function* () {
    const exposure = yield* Config.schema(Exposure, "MEND_EXPOSURE").pipe(
      // `private`, not `loopback`: an unset variable is far more often a tailnet or LAN install
      // than one reached from its own machine, and the two differ only in what the report says.
      Config.withDefault("private" as const),
    );
    const declaredRaw = yield* Config.String("MEND_EXPOSURE_DECLARED").pipe(Config.withDefault(""));
    const stated = declaredRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const unknown = stated.filter((entry) => !DECLARABLE.some((id) => id === entry));
    if (unknown.length > 0) {
      return yield* new ExposureRefused({
        message: `MEND_EXPOSURE_DECLARED names ${unknown.join(", ")}: only ${DECLARABLE.join(", ")} can be declared; every other item is observed by this process or not at all.`,
      });
    }
    const reassessed = yield* Config.String("MEND_EXPOSURE_REASSESSED").pipe(Config.option);
    const version = yield* Config.String("MEND_VERSION").pipe(Config.withDefault("dev"));
    // The switch the bundle starts the gateway by (scripts/bundle-supervisor.mjs).
    const t3Gateway = ["1", "true"].includes(
      (yield* Config.String("MEND_T3_GATEWAY_ENABLED").pipe(Config.withDefault("")))
        .trim()
        .toLowerCase(),
    );
    const t3GatewayPublished = t3Gateway
      ? yield* optionalString("MEND_T3_GATEWAY_PUBLISHED")
      : undefined;
    const t3GatewayUrl = t3Gateway ? yield* optionalString("MEND_T3_GATEWAY_URL") : undefined;
    const network = yield* NetworkConfig;
    const deployment = yield* DeploymentConfig;
    const mirrorHosts = [
      yield* Config.String("MEND_NPM_MIRROR_URL").pipe(Config.withDefault("")),
      ...(yield* Config.String("SEALANT_DOCKER_REGISTRY_MIRRORS").pipe(
        Config.withDefault(""),
      )).split(","),
    ].flatMap((value) => {
      try {
        return value.trim() === "" ? [] : [new URL(value.trim()).host];
      } catch {
        return [];
      }
    });
    const tenancy = yield* TenancyConfig;
    const posture: Omit<ExposurePosture, "tenancyGate"> = {
      appUrl: network.appUrl,
      allowedOrigins: network.allowedOrigins,
      trustedProxies: yield* trustedProxyCidrs,
      budgetsOff: budgetsOff((yield* Budgets).limits),
      urlBearers: (yield* UrlBearers).mode,
      errorDetail: (yield* ErrorDetail).mode,
      sessionChannelUrl: deployment.sessionEndpoint?.url,
      // The same statement the session engine sends to every capture launch as
      // `source.transport.plaintext`: one variable, read once (`DeploymentConfig`).
      executorNetwork: deployment.executorTransport?.plaintext === true ? "private" : undefined,
      sshPublished: Option.getOrUndefined(
        yield* Config.String("MEND_SSH_PUBLISHED").pipe(Config.option),
      ),
      declared: DECLARABLE.filter((id) => stated.includes(id)),
      reassessedVersion: reassessed._tag === "Some" ? reassessed.value : undefined,
      version,
      mirrors: mirrorHosts,
      t3Gateway,
      ...(t3GatewayPublished === undefined ? {} : { t3GatewayPublished }),
      ...(t3GatewayUrl === undefined ? {} : { t3GatewayUrl }),
    };
    const gateWith = (tenancyGate: ReadonlyArray<GateOutcome>) =>
      evaluateExposureGate({ ...posture, tenancyGate });
    const currentGate = tenancy.gate.pipe(Effect.map(gateWith));
    const gate = yield* currentGate;
    const refusal = exposureRefusal(exposure, gate);
    if (refusal !== null) return yield* new ExposureRefused({ message: refusal });
    yield* Effect.logInfo("exposure").pipe(
      Effect.annotateLogs({
        declared: exposure,
        gate: exposureGatePasses(gate) ? "nothing open" : "open items",
        open: gate
          .filter((outcome) => outcome.established === "open")
          .map((outcome) => outcome.id)
          .join(","),
      }),
    );
    return {
      exposure,
      gate: currentGate,
      gateWith,
      t3Gateway: t3Gateway
        ? { url: t3GatewayUrl ?? null, published: t3GatewayPublished ?? null }
        : undefined,
    };
  }),
);
