import * as net from "node:net";

import { EDGE_CADDYFILE, EDGE_COMPOSE_OVERLAY } from "./server-edge-files.ts";

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

export { EDGE_CADDYFILE, EDGE_COMPOSE_OVERLAY };

/**
 * The public exposure gate's items an operator can state they verified from outside
 * (`MEND_EXPOSURE_DECLARED`; apps/api/src/exposure.ts `DECLARABLE`). `mend server setup --declare`
 * names them; nothing else reaches the server's statement.
 */
export const DECLARABLE_ITEMS = ["core-private", "edge-tls", "workspace-ssh"] as const;
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
}

/** `<address>:<port>` as Compose and the gate read it: IPv6 in brackets. */
export const publishedAddress = (address: string, port: number): string =>
  `${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`;

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

/** The `KEY=value` lines the posture and the edge add to `server.env`. */
export const postureEnvLines = (posture: ServerPosture): ReadonlyArray<string> => [
  ...(posture.edgeHost === undefined ? [] : [`MEND_EDGE_HOST=${posture.edgeHost}`]),
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

/** The overlay files a generation holds beside `compose.yaml`, in the order Compose merges them. */
export const composeOverlays = (posture: ServerPosture): ReadonlyArray<string> => [
  ...(posture.edgeHost === undefined ? [] : [EDGE_COMPOSE_FILE]),
  ...(renderPostureOverlay(posture) === undefined ? [] : [POSTURE_COMPOSE_FILE]),
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

/** The posture as the install declares it, one line each; a default is said to be one. */
export const declaredPostureLines = (posture: ServerPosture): ReadonlyArray<string> => [
  ...(posture.edgeHost === undefined
    ? []
    : [`edge · ${posture.edgeHost} · ${EDGE_IMAGE} on 80 and 443 · Mend's own port on loopback`]),
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
