import * as net from "node:net";

import { EDGE_CADDYFILE, EDGE_COMPOSE_OVERLAY } from "./server-edge-files.ts";
import { MIRRORS_COMPOSE_FILE, runsMirrors, type ServerMirrors } from "./server-mirrors.ts";

/**
 * The edge and the posture of a packaged install (docs/adr/0004-access-without-a-private-network.md
 * "The access model"; docs/adr/0003-organizations-and-tenancy.md "Multi mode gate").
 *
 * Both live in the server config and render into the generation: `server.env` carries the values,
 * `compose.edge.yaml` and `Caddyfile` are the repository's edge overlay byte for byte, and
 * `compose.posture.yaml` names which posture variables reach the `mend` container. Nothing here is
 * read from a second place: an upgrade re-renders the same files from the carried config.
 */

export const EXPOSURES = ["loopback", "private", "public"] as const;
/** `MEND_EXPOSURE`, as the operator declares it. */
export type Exposure = (typeof EXPOSURES)[number];

export const TENANCIES = ["single", "multi"] as const;
/** `MEND_TENANCY`. */
export type Tenancy = (typeof TENANCIES)[number];

export const isExposure = (value: string): value is Exposure =>
  EXPOSURES.some((exposure) => exposure === value);
export const isTenancy = (value: string): value is Tenancy =>
  TENANCIES.some((tenancy) => tenancy === value);

/** The edge image the overlay pins; `checkLocalImages` preloads it like Postgres's. */
export const EDGE_IMAGE = "caddy:2.10-alpine";
/** The files of a generation beyond the release assets. */
export const EDGE_COMPOSE_FILE = "compose.edge.yaml";
export const EDGE_CADDYFILE_NAME = "Caddyfile";
export const POSTURE_COMPOSE_FILE = "compose.posture.yaml";
export const T3_GATEWAY_COMPOSE_FILE = "compose.t3.yaml";
/** The t3code gateway's port in the `mend` container (`scripts/bundle-supervisor.mjs`). */
export const T3_GATEWAY_CONTAINER_PORT = 3120;
/** The host port `--t3-gateway` publishes it on unless `--t3-gateway-port` names another. */
export const DEFAULT_T3_GATEWAY_PORT = 3120;
/**
 * The edge's site for the gateway, when `--t3-gateway-origin` names a host for it: a file of the
 * generation, mounted where the Caddyfile imports sites from.
 */
export const T3_GATEWAY_CADDYFILE_NAME = "Caddyfile.t3";
export const T3_GATEWAY_CADDY_SITE = "/etc/caddy/sites/t3code-gateway.caddy";

export { EDGE_CADDYFILE, EDGE_COMPOSE_OVERLAY };

/**
 * The public exposure gate's items an operator can state they verified from outside
 * (`MEND_EXPOSURE_DECLARED`; apps/api/src/exposure.ts `DECLARABLE`). `mend server setup --declare`
 * names them; nothing else reaches the server's statement.
 */
export const DECLARABLE_ITEMS = [
  "core-private",
  "edge-tls",
  "workspace-ssh",
  "t3code-gateway",
] as const;
export type DeclarableItem = (typeof DECLARABLE_ITEMS)[number];

export const isDeclarableItem = (value: string): value is DeclarableItem =>
  DECLARABLE_ITEMS.some((item) => item === value);

/** What a server config says about how the install is reached and for whom. */
export interface ServerPosture {
  /** The name the edge's certificate is for; absent, no edge runs. */
  readonly edgeHost?: string;
  readonly exposure?: Exposure;
  readonly tenancy?: Tenancy;
  /** Where workspace SSH is published apart from the web port (`--ssh-bind`); absent, it is not. */
  readonly sshBind?: string;
  readonly sshPort?: number;
  /** The gate items the operator states they verified from outside (`--declare`). */
  readonly declared?: ReadonlyArray<DeclarableItem>;
  /**
   * Where Mend's own web port is published, and the origin people open. The t3code gateway follows
   * them; absent, it reads as loopback.
   */
  readonly bind?: string;
  readonly appUrl?: string;
  /**
   * The t3code gateway's host port (docs/adr/0012), published where Mend's web port is; absent,
   * the gateway does not run.
   */
  readonly t3GatewayPort?: number;
  /** The host the edge serves the gateway on, its own origin (`--t3-gateway-origin`). */
  readonly t3GatewayOrigin?: string;
}

/** `<address>:<port>` as Compose and the gate read it: IPv6 in brackets. */
export const publishedAddress = (address: string, port: number): string =>
  `${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`;

const isLoopbackBindAddress = (address: string): boolean =>
  address === "::1" || address.startsWith("127.");

/** An address as a URL's host: IPv6 in brackets, every address as this machine's own loopback. */
const urlHostOf = (address: string): string =>
  address === "0.0.0.0"
    ? "127.0.0.1"
    : address === "::"
      ? "[::1]"
      : net.isIP(address) === 6
        ? `[${address}]`
        : address;

/**
 * Where a packaged install puts the t3code gateway (docs/adr/0012, "Access"; ADR 0004), and what a
 * T3 Code client enters in its Remote link. The gateway follows the exposure Mend's web port has:
 *
 * - on loopback, it stays on loopback;
 * - on a private address (a tailnet, a LAN), it is published on that same address, so a client on
 *   that network reaches it as it reaches Mend, with no tunnel;
 * - behind the edge, Mend's own port is on loopback and the gateway's stays beside it. The edge
 *   serves it only on an origin of its own (`--t3-gateway-origin`): a t3code client always uses a
 *   server's root path, so it cannot sit under a path of Mend's origin. Its raw port is never
 *   published beyond loopback on a public install.
 *
 * Every device pairs through Mend whatever the address, so who may use it does not change.
 */
export interface T3GatewayPlacement {
  /** The host address its port is published on. */
  readonly bind: string;
  readonly port: number;
  /** What T3 Code's Remote link takes, with a code from `mend pair`. */
  readonly url: string;
  /** Where this machine reads it: its published address, every address read as loopback. */
  readonly probeUrl: string;
  /** The host the edge serves it on, when it does. */
  readonly edgeHost?: string;
}

export const t3GatewayPlacement = (posture: ServerPosture): T3GatewayPlacement | undefined => {
  const port = posture.t3GatewayPort;
  if (port === undefined) return undefined;
  const web = posture.bind ?? "127.0.0.1";
  const behindEdge = posture.edgeHost !== undefined || posture.exposure === "public";
  const bind = behindEdge && !isLoopbackBindAddress(web) ? "127.0.0.1" : web;
  const probeUrl = `http://${urlHostOf(bind)}:${port}`;
  if (posture.edgeHost !== undefined && posture.t3GatewayOrigin !== undefined) {
    return {
      bind,
      port,
      url: `https://${posture.t3GatewayOrigin}`,
      probeUrl,
      edgeHost: posture.t3GatewayOrigin,
    };
  }
  if (isLoopbackBindAddress(bind)) return { bind, port, url: probeUrl, probeUrl };
  // The name people already reach Mend by, on the gateway's port; the address when there is none.
  const named = (() => {
    try {
      return posture.appUrl === undefined ? null : new URL(posture.appUrl).hostname;
    } catch {
      return null;
    }
  })();
  const host = named === null || named === "" ? urlHostOf(bind) : named;
  return { bind, port, url: `http://${host}:${port}`, probeUrl };
};

/** Whether the gateway answers from another machine without anything put in front of it. */
export const t3GatewayBeyondMachine = (placement: T3GatewayPlacement): boolean =>
  !isLoopbackBindAddress(placement.bind);

/**
 * A DNS name a public certificate can be issued for: two labels or more, letters, digits and
 * hyphens, no IP literal. Lowercased, a trailing dot dropped.
 */
export const parseEdgeHost = (value: string): string | null => {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    host.length === 0 ||
    host.length > 253 ||
    labels.length < 2 ||
    !labels.every((part) => label.test(part)) ||
    net.isIP(host) !== 0
  ) {
    return null;
  }
  return host;
};

/**
 * The variables the posture puts in `server.env`, in order. `MEND_EXPOSURE` and `MEND_TENANCY`
 * are the operator's statements. With `multi`, and for a `public` exposure (ADR 0004 item 5: an
 * Internet-facing single-organization install needs the same items closed), the multi mode gate's
 * configuration items follow: Mend's own git keeps to the tenant source policy and every capture
 * upload is signed for its size. `MEND_GIT_TRANSPORT_BIND_ORIGIN` and `MEND_SERVICE_HOSTS` stay
 * unset, which is what the gate asks of them. A `public` exposure also refuses bearers in URLs,
 * which its gate needs (`no-bearers-in-urls`).
 */
export const postureEnvironment = (
  posture: ServerPosture,
): ReadonlyArray<readonly [string, string]> => {
  const gate = posture.tenancy === "multi" || posture.exposure === "public";
  return [
    ...(posture.exposure === undefined ? [] : [["MEND_EXPOSURE", posture.exposure] as const]),
    ...(posture.tenancy === undefined ? [] : [["MEND_TENANCY", posture.tenancy] as const]),
    ...(gate
      ? [["MEND_SOURCE_POLICY", "tenant"] as const, ["MEND_CAPTURE_REQUIRE_SIZES", "true"] as const]
      : []),
    ...(posture.exposure === "public" ? [["MEND_URL_BEARERS", "refuse"] as const] : []),
    // The gate's workspace-ssh item reads where SSH is published apart from the web port; the
    // container cannot see what its host publishes.
    ...(posture.sshBind === undefined || posture.sshPort === undefined
      ? []
      : [["MEND_SSH_PUBLISHED", publishedAddress(posture.sshBind, posture.sshPort)] as const]),
    ...(posture.declared === undefined || posture.declared.length === 0
      ? []
      : [["MEND_EXPOSURE_DECLARED", posture.declared.join(",")] as const]),
  ];
};

/**
 * The t3code gateway's lines in `server.env`, read by `compose.t3.yaml` only: where its port is
 * published, and what the server reports about it (the exposure gate's `t3code-gateway` item,
 * `/api/machine`, which `mend pair` and `mend doctor` read). With an edge origin, the host Caddy
 * serves it on.
 */
export const t3GatewayEnvLines = (posture: ServerPosture): ReadonlyArray<string> => {
  const placement = t3GatewayPlacement(posture);
  if (placement === undefined) return [];
  return [
    `MEND_T3_GATEWAY_PORT=${placement.port}`,
    `MEND_T3_GATEWAY_BIND_HOST=${net.isIP(placement.bind) === 6 ? `[${placement.bind}]` : placement.bind}`,
    `MEND_T3_GATEWAY_PUBLISHED=${publishedAddress(placement.bind, placement.port)}`,
    `MEND_T3_GATEWAY_URL=${placement.url}`,
    ...(placement.edgeHost === undefined
      ? []
      : [`MEND_T3_GATEWAY_EDGE_HOST=${placement.edgeHost}`]),
  ];
};

/** The `KEY=value` lines the posture and the edge add to `server.env`. */
export const postureEnvLines = (posture: ServerPosture): ReadonlyArray<string> => [
  ...(posture.edgeHost === undefined ? [] : [`MEND_EDGE_HOST=${posture.edgeHost}`]),
  ...t3GatewayEnvLines(posture),
  ...postureEnvironment(posture).map(([key, value]) => `${key}=${value}`),
];

/**
 * `compose.posture.yaml`: the overlay that hands the posture to the `mend` container. It names
 * each variable and reads its value from `server.env`, so the value lives in one place. Absent
 * when no posture is declared, and the install renders as it did before the posture existed.
 */
export const renderPostureOverlay = (posture: ServerPosture): string | undefined => {
  const entries = postureEnvironment(posture);
  if (entries.length === 0) return undefined;
  return [
    "# Written by mend server setup: the posture this install declares, read from server.env",
    "# (docs/adr/0003-organizations-and-tenancy.md, docs/adr/0004-access-without-a-private-network.md).",
    "# MEND_EXPOSURE and MEND_TENANCY are the operator's statements. With multi tenancy or a public",
    "# exposure, the multi mode gate's configuration items follow: Mend's own git keeps to the tenant",
    "# source policy and every capture upload is signed for its size. MEND_GIT_TRANSPORT_BIND_ORIGIN",
    "# and MEND_SERVICE_HOSTS are not set, which is what the gate asks of them.",
    "services:",
    "  mend:",
    "    environment:",
    ...entries.map(([key]) => `      ${key}: \${${key}:?set ${key} in server.env}`),
    "",
  ].join("\n");
};

/**
 * The gateway's state (pairings, the queue, archive flags) in a volume of its own, mounted in the
 * root the gateway is confined to (scripts/t3-gateway-root.sh): never in Mend's config volume,
 * which the gateway cannot see. It stays when the gateway is turned off.
 */
export const T3_GATEWAY_VOLUME = "mend-t3-gateway";
/** The label an image that carries the confined gateway has, set to `1` (Dockerfile). */
export const T3_GATEWAY_IMAGE_LABEL = "dev.sealant.mend.t3-gateway";
export const T3_GATEWAY_STATE_DIR = "/opt/mend-t3-gateway/state";

/** A Compose reference to a `server.env` value that refuses to start without it. */
const required = (key: string): string => `\${${key}:?set ${key} in server.env}`;

/**
 * `compose.t3.yaml`: the t3code gateway (docs/adr/0012, phase 4), when the operator turned it on.
 * It turns the gateway on in the `mend` container, publishes its port where Mend's web port is
 * published (`t3GatewayPlacement`), hands Mend what it reports about it, and mounts its state
 * volume. With an edge origin for it, the edge mounts the gateway's site and serves it there.
 * Absent when it is off.
 */
export const renderT3GatewayOverlay = (posture: ServerPosture): string | undefined => {
  const placement = t3GatewayPlacement(posture);
  if (placement === undefined) return undefined;
  return [
    "# Written by mend server setup --t3-gateway: the t3code gateway (docs/adr/0012), its own",
    "# listener beside Mend's, published on the address Mend's web port is published on. Every device",
    "# pairs through Mend. mend server setup --no-t3-gateway removes it.",
    "services:",
    "  mend:",
    "    environment:",
    '      MEND_T3_GATEWAY_ENABLED: "true"',
    "      # What the exposure report, mend pair and mend doctor say about it.",
    `      MEND_T3_GATEWAY_PUBLISHED: ${required("MEND_T3_GATEWAY_PUBLISHED")}`,
    `      MEND_T3_GATEWAY_URL: ${required("MEND_T3_GATEWAY_URL")}`,
    "    ports:",
    `      - "${required("MEND_T3_GATEWAY_BIND_HOST")}:${required("MEND_T3_GATEWAY_PORT")}:${T3_GATEWAY_CONTAINER_PORT}"`,
    "    volumes:",
    `      - ${T3_GATEWAY_VOLUME}:${T3_GATEWAY_STATE_DIR}`,
    ...(placement.edgeHost === undefined
      ? []
      : [
          "  # The edge serves the gateway on its own origin (--t3-gateway-origin): Caddy gets a",
          "  # certificate for it once its DNS points here, and reaches the gateway on the edge network.",
          "  edge:",
          "    environment:",
          `      MEND_T3_GATEWAY_EDGE_HOST: ${required("MEND_T3_GATEWAY_EDGE_HOST")}`,
          "    volumes:",
          `      - ./${T3_GATEWAY_CADDYFILE_NAME}:${T3_GATEWAY_CADDY_SITE}:ro`,
        ]),
    "volumes:",
    `  ${T3_GATEWAY_VOLUME}:`,
    "",
  ].join("\n");
};

/**
 * `Caddyfile.t3`: the edge's site for the gateway, which the Caddyfile imports. TLS ends here, as
 * for Mend's own origin; the gateway's sockets and streams are long-lived. Its socket carries a
 * single-use ticket in the query (`wsTicket`), which no log holds.
 */
export const T3_GATEWAY_CADDYFILE = [
  "# Written by mend server setup --t3-gateway-origin: the t3code gateway (docs/adr/0012) on an",
  "# origin of its own. A t3code client always uses a server's root path, so it cannot share Mend's.",
  "{$MEND_T3_GATEWAY_EDGE_HOST} {",
  "\tencode zstd gzip",
  "",
  `\treverse_proxy mend:${T3_GATEWAY_CONTAINER_PORT} {`,
  "\t\t# The gateway's socket and its streams are long-lived: never buffer them.",
  "\t\tflush_interval -1",
  "\t}",
  "",
  "\tlog {",
  "\t\toutput stdout",
  "\t\tformat filter {",
  "\t\t\twrap json",
  "\t\t\tfields {",
  "\t\t\t\trequest>uri query {",
  "\t\t\t\t\treplace wsTicket REDACTED",
  "\t\t\t\t\treplace token REDACTED",
  "\t\t\t\t}",
  "\t\t\t\trequest>headers>Referer delete",
  "\t\t\t}",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

/** The overlay files a generation holds beside `compose.yaml`, in the order Compose merges them. */
export const composeOverlays = (
  posture: ServerPosture & { readonly mirrors?: ServerMirrors },
): ReadonlyArray<string> => [
  ...(posture.edgeHost === undefined ? [] : [EDGE_COMPOSE_FILE]),
  ...(renderPostureOverlay(posture) === undefined ? [] : [POSTURE_COMPOSE_FILE]),
  ...(runsMirrors(posture.mirrors) ? [MIRRORS_COMPOSE_FILE] : []),
  ...(posture.t3GatewayPort === undefined ? [] : [T3_GATEWAY_COMPOSE_FILE]),
];

// ── what `mend server status` says ─────────────────────────────────────────

/** The facts `/api/health` carries about the posture; each absent on a server older than it. */
export interface HealthPosture {
  readonly tenancy: Tenancy | null;
  readonly tenancyGate: {
    readonly passed: boolean;
    readonly failing: ReadonlyArray<string>;
  } | null;
  readonly exposure: {
    readonly declared: Exposure;
    readonly open: number;
    readonly unobservable: number;
  } | null;
}

const record = (value: unknown): ReadonlyMap<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Map(Object.entries(value))
    : null;

/** What a health body says about tenancy and exposure; a field that is not there reads null. */
export const healthPosture = (body: unknown): HealthPosture => {
  const fields = record(body);
  const tenancy = fields?.get("tenancy");
  const gate = record(fields?.get("tenancyGate"));
  const passed = gate?.get("passed");
  const failing = gate?.get("failing");
  const exposure = record(fields?.get("exposure"));
  const declared = exposure?.get("declared");
  const open = exposure?.get("open");
  const unobservable = exposure?.get("unobservable");
  return {
    tenancy: typeof tenancy === "string" && isTenancy(tenancy) ? tenancy : null,
    tenancyGate:
      typeof passed === "boolean" && Array.isArray(failing)
        ? {
            passed,
            failing: failing.filter((item): item is string => typeof item === "string"),
          }
        : null,
    exposure:
      typeof declared === "string" &&
      isExposure(declared) &&
      typeof open === "number" &&
      typeof unobservable === "number"
        ? { declared, open, unobservable }
        : null,
  };
};

/** The gateway as the install publishes it, in one line; none when it is off. */
const t3GatewayDeclaredLines = (posture: ServerPosture): ReadonlyArray<string> => {
  const placement = t3GatewayPlacement(posture);
  if (placement === undefined) return [];
  const published = publishedAddress(placement.bind, placement.port);
  return [
    placement.edgeHost !== undefined
      ? `t3code gateway · on · served by the edge at ${placement.url} · its port published on ${published} only`
      : t3GatewayBeyondMachine(placement)
        ? `t3code gateway · on · published on ${published}, where Mend's web port is · T3 Code's Remote link takes ${placement.url}`
        : `t3code gateway · on · published on ${published} only · reached from this machine${posture.edgeHost === undefined ? "" : "; mend server setup --t3-gateway-origin <host> serves it through the edge"}`,
  ];
};

/** The posture as the install declares it, one line each; a default is said to be one. */
export const declaredPostureLines = (posture: ServerPosture): ReadonlyArray<string> => [
  ...(posture.edgeHost === undefined
    ? []
    : [`edge · ${posture.edgeHost} · ${EDGE_IMAGE} on 80 and 443 · Mend's own port on loopback`]),
  ...t3GatewayDeclaredLines(posture),
  `exposure · declared ${posture.exposure ?? "private"}${posture.exposure === undefined ? " · the default, not set on this install" : ""}`,
  `tenancy · declared ${posture.tenancy ?? "single"}${posture.tenancy === undefined ? " · the default, not set on this install" : ""}`,
  ...(posture.sshBind === undefined || posture.sshPort === undefined
    ? []
    : [
        `workspace ssh · published on ${publishedAddress(posture.sshBind, posture.sshPort)} apart from the web port`,
      ]),
  ...(posture.declared === undefined || posture.declared.length === 0
    ? []
    : [`stated verified from outside · ${posture.declared.join(", ")}`]),
];

/**
 * What a look into Caddy's data found: the certificate file for the host, none there, or no look
 * at all. Only the first two are observations; the third says why there was none.
 */
export type EdgeCertificate =
  | { readonly kind: "observed"; readonly file: string }
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** What the edge's container and Caddy's data showed. */
export interface EdgeObservation {
  /** Whether the `edge` service is among the running Compose services. */
  readonly running: boolean;
  readonly certificate: EdgeCertificate;
}

export const observedEdgeLine = (host: string, observed: EdgeObservation): string =>
  [
    `edge · ${host}`,
    observed.running ? "container running" : "container not running",
    observed.certificate.kind === "observed"
      ? `certificate observed in Caddy's data · ${observed.certificate.file}`
      : observed.certificate.kind === "none"
        ? "no certificate in Caddy's data yet · mend server logs shows what Caddy tried"
        : `certificate not observed · ${observed.certificate.reason}`,
  ].join(" · ");

/** The posture as the running server reports it, beside what was declared. */
export const observedPostureLines = (
  posture: ServerPosture,
  health: HealthPosture,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (health.exposure === null) {
    lines.push("exposure · observed · this server reports no exposure · it predates the gate");
  } else {
    const { declared, open, unobservable } = health.exposure;
    const observable = open - unobservable;
    lines.push(
      [
        `exposure · observed ${declared}`,
        open === 0
          ? "public exposure gate · nothing open"
          : `public exposure gate · ${open} item${open === 1 ? "" : "s"} open · ${observable} this build can observe · ${unobservable} no build can`,
        "mend operator exposure lists them",
      ].join(" · "),
    );
    if (posture.exposure !== undefined && declared !== posture.exposure) {
      lines.push(
        `exposure · the running server declares ${declared}, this install ${posture.exposure}: it was started before the last mend server setup`,
      );
    }
  }
  if (health.tenancy === null || health.tenancyGate === null) {
    lines.push("tenancy · observed · this server reports no tenancy · it predates organizations");
  } else {
    const { failing } = health.tenancyGate;
    lines.push(
      [
        `tenancy · observed ${health.tenancy}`,
        failing.length === 0
          ? "multi mode gate · nothing open"
          : `multi mode gate · open: ${failing.join(", ")}`,
        "mend operator gate lists every item",
      ].join(" · "),
    );
    if (posture.tenancy !== undefined && health.tenancy !== posture.tenancy) {
      lines.push(
        `tenancy · the running server declares ${health.tenancy}, this install ${posture.tenancy}: it was started before the last mend server setup`,
      );
    }
  }
  return lines;
};
