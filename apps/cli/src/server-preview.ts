import { createPrivateKey, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFAULT_TAILNET_PREVIEW_PORTS,
  NO_SUCH_PREVIEW,
  previewDomainConflict,
  previewDomainOverlap,
  readPreviewPorts,
  sessionCookiePrefix,
  writePreviewPorts,
} from "@mend/network";

import {
  type DeclarableItem,
  type DomainPreview,
  type Exposure,
  PREVIEW_GATEWAY_PORT,
  PREVIEW_PUBLISHED,
  type ServerPreview,
  type TailnetPreview,
} from "./server-edge.ts";
import { setupError } from "./server-setup-error.ts";
import type { ServeRoute, TailscaleFacts } from "./server-setup-guide.ts";
import type { ServerConfig, ServerSetupRuntime } from "./server-setup.ts";

/** Nothing Compose's short volume syntax or `server.env` reads as a separator or a variable. */
export const parsePreviewFile = (value: string): string | null => {
  const file = path.normalize(value.trim());
  const separated = [...file].some(
    (character) => character.charCodeAt(0) < 0x20 || ":#$\"'`\\".includes(character),
  );
  return path.isAbsolute(file) && !separated && !file.endsWith(" ") ? file : null;
};

const APART =
  "A page on a preview could then act as Mend's own site: previews need a domain apart from Mend's, such as a registrable domain of their own.";

export const previewDomainProblem = (
  domain: string,
  mend: ReadonlyArray<{ readonly host: string; readonly what: string }>,
): string | null => {
  for (const { host, what } of mend) {
    const overlap = previewDomainConflict(domain, host);
    if (overlap === null) continue;
    switch (overlap.kind) {
      case "holds":
        return `--preview-domain ${domain} holds ${what} ${host}. ${APART}`;
      case "under":
        return `--preview-domain ${domain} is under ${what} ${host}. ${APART}`;
    }
  }
  return null;
};

/**
 * What a Mend image's previews can do, by its `dev.sealant.mend.previews` label: a comma-separated
 * list. An image from before ADR 0017 step 8b carries none, reads `MEND_PREVIEW_TAILNET_PORTS` as
 * `port=preview` pairs and refuses a preview domain on Mend's own site, each at start.
 */
export const PREVIEWS_IMAGE_LABEL = "dev.sealant.mend.previews";

const PREVIEW_CAPABILITIES = {
  "tailnet-ports": {
    what: "previews on the tailnet",
    variable: "MEND_PREVIEW_TAILNET_PORTS",
    them: "them",
    off: "--no-preview-tailnet",
  },
  "same-site-domain": {
    what: "a preview domain on Mend's own site",
    variable: "MEND_PREVIEW_DOMAIN",
    them: "it",
    off: "--no-preview-domain",
  },
} as const;

export type PreviewCapability = keyof typeof PREVIEW_CAPABILITIES;

export const requiredPreviewCapability = (
  config: Pick<ServerConfig, "preview" | "appUrl" | "allowedOrigins">,
): PreviewCapability | null => {
  const preview = config.preview;
  if (preview === undefined) return null;
  if (preview.mode === "tailnet") return "tailnet-ports";
  const sameSite = [config.appUrl, ...config.allowedOrigins].some(
    (origin) =>
      previewDomainOverlap(preview.domain, new URL(origin).hostname)?.kind === "same-site",
  );
  return sameSite ? "same-site-domain" : null;
};

export const previewImageProblem = (
  serverVersion: string,
  needed: PreviewCapability,
  label: string,
): string | null => {
  if (label.split(",").some((entry) => entry.trim() === needed)) return null;
  const { what, variable, them, off } = PREVIEW_CAPABILITIES[needed];
  return `Mend ${serverVersion} predates ${what} (its image's ${PREVIEWS_IMAGE_LABEL} label does not name ${needed}), and would refuse ${variable} at start. Upgrade the server to a version that has ${them} with mend server upgrade --version <version>, then turn ${them} on; or run mend server setup ${off}.`;
};

/** The certificate for `*.<domain>` and its key, as absolute paths on this machine. */
export interface PreviewFiles {
  readonly certificate: string;
  readonly key: string;
}

/**
 * What a run's flags ask of previews. `Keep` re-checks the saved ones; `Saved` re-checks a config
 * read back, as it is.
 */
export type PreviewRequest =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Saved"; readonly preview: ServerPreview }
  | { readonly _tag: "Off"; readonly modes: ReadonlyArray<ServerPreview["mode"]> }
  | {
      readonly _tag: "Domain";
      readonly domain: string | undefined;
      readonly files: PreviewFiles | undefined;
    }
  | { readonly _tag: "Tailnet"; readonly ports: ReadonlyArray<number> | undefined };

export const KEEP_PREVIEW: PreviewRequest = { _tag: "Keep" };

/** A list of ports and ranges, read as the server reads `MEND_PREVIEW_TAILNET_PORTS`. */
export const parsePreviewPorts = (value: string, what: string): ReadonlyArray<number> => {
  const read = readPreviewPorts(value);
  if (read._tag === "Refused") throw setupError(`${what}: ${read.problem}.`);
  return read.ports;
};

/** The Tailscale Service the tailnet mode's previews are served under (ADR 0017, decision 6). */
export const TAILNET_PREVIEW_SERVICE = "svc:mend-preview";
const TAILNET_PREVIEW_LABEL = "mend-preview";

/**
 * What setup read of Tailscale for the tailnet mode, on the machine that runs Mend. `served` is
 * what `tailscale serve` there serves for the Service; null when its status was not read.
 */
export type TailnetObservation =
  | {
      readonly _tag: "Observed";
      readonly hostname: string;
      /** This machine's own MagicDNS name. */
      readonly self: string | null;
      readonly served: ReadonlyArray<ServeRoute> | null;
    }
  | { readonly _tag: "Refused"; readonly problem: string };

const AGAIN = "then run mend server setup --preview-tailnet again";

/**
 * Tailscale on this machine, for the tailnet mode. Setup acts on the Docker host it targets, and
 * only a local socket is this machine: elsewhere, this machine's `tailscale` describes another.
 */
export const observeTailnet = async (
  readTailscale: () => Promise<TailscaleFacts | null>,
  dockerEndpoint: string,
): Promise<TailnetObservation> => {
  if (!dockerEndpoint.startsWith("unix://"))
    return {
      _tag: "Refused",
      problem: `Docker here is ${dockerEndpoint}, another machine. Previews on the tailnet are served by tailscale serve on the machine that runs Mend, and the tailscale on this machine describes this one. Run mend server setup --preview-tailnet on the machine that runs Mend.`,
    };
  const facts = await readTailscale();
  if (facts === null)
    return {
      _tag: "Refused",
      problem: `Observed: tailscale did not answer on this machine. Previews on the tailnet are served by tailscale serve here: install Tailscale and join this machine to your tailnet (tailscale up), ${AGAIN}.`,
    };
  if (!facts.running)
    return {
      _tag: "Refused",
      problem: `Observed: Tailscale on this machine is not running. Start it (tailscale up), ${AGAIN}.`,
    };
  if (facts.magicDnsSuffix === null)
    return {
      _tag: "Refused",
      problem: `Observed: Tailscale on this machine reports no MagicDNS suffix for its tailnet, and the previews' name is mend-preview.<suffix>. Turn MagicDNS on in the Tailscale admin console (DNS), ${AGAIN}.`,
    };
  if (!facts.magicDns)
    return {
      _tag: "Refused",
      problem: `Observed: MagicDNS is off for this machine's tailnet, and the previews' name is ${TAILNET_PREVIEW_LABEL}.${facts.magicDnsSuffix}. Turn MagicDNS on in the Tailscale admin console (DNS), ${AGAIN}.`,
    };
  return {
    _tag: "Observed",
    hostname: `${TAILNET_PREVIEW_LABEL}.${facts.magicDnsSuffix}`,
    self: facts.dnsName,
    served: facts.services === null ? null : (facts.services.get(TAILNET_PREVIEW_SERVICE) ?? []),
  };
};

const servedFrom = (bind: string, port: number): string => {
  const host = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
};

/**
 * Every name in one tailnet is one site (`ts.net` is on the Public Suffix List), and only an https
 * APP_URL gives Mend's cookies the `__Host-` prefix that a preview's page cannot set. Decided by
 * Yiannis, 2026-10-29: refused over http, with the way to https offered.
 */
export const tailnetAppUrlProblem = (
  mend: { readonly appUrl: string; readonly bind: string; readonly appPort: number },
  self: string | null,
): string | null => {
  if (sessionCookiePrefix(mend.appUrl) === "__Host-") return null;
  return `Previews on the tailnet need Mend's own URL on https, and it is ${mend.appUrl}. They share Mend's site (every name in one tailnet is one registrable domain under ts.net), and only an https URL gives Mend's cookies the __Host- prefix, which a page on a preview cannot set. Serve Mend's web port over Tailscale on this machine: tailscale serve --bg --https=443 ${servedFrom(mend.bind, mend.appPort)}. Then run mend server setup --url https://${self ?? "<this machine's MagicDNS name>"} --preview-tailnet.`;
};

/** What Mend's setup already holds, against which a preview is checked. */
export interface PreviewContext {
  readonly edgeHost: string | undefined;
  readonly hosts: ReadonlyArray<{ readonly host: string; readonly what: string }>;
  readonly ports: ReadonlyArray<number>;
  readonly exposure: Exposure | undefined;
  readonly declared: ReadonlyArray<DeclarableItem>;
  readonly appUrl: string;
  readonly bind: string;
  readonly appPort: number;
  /** Tailscale on this machine; absent when setup did not look (a config read back, the guide). */
  readonly tailnet: TailnetObservation | undefined;
}

export const resolvePreview = (
  existing: ServerPreview | undefined,
  request: PreviewRequest,
  mend: PreviewContext,
): ServerPreview | undefined => {
  switch (request._tag) {
    case "Saved":
      return recheck(request.preview, mend);
    case "Off":
      return existing === undefined || request.modes.includes(existing.mode)
        ? undefined
        : recheck(existing, mend);
    case "Keep":
      return existing === undefined ? undefined : recheck(existing, mend);
    case "Domain": {
      const saved = existing?.mode === "domain" ? existing : undefined;
      const domain = request.domain ?? saved?.domain;
      if (domain === undefined)
        throw setupError("--preview-certificate and --preview-key need --preview-domain <domain>.");
      return resolveDomain(domain, request.files ?? saved, request.domain !== undefined, mend);
    }
    case "Tailnet": {
      const saved = existing?.mode === "tailnet" ? existing : undefined;
      return resolveTailnet(
        saved,
        request.ports ??
          saved?.ports ??
          parsePreviewPorts(DEFAULT_TAILNET_PREVIEW_PORTS, "The default preview ports"),
        mend,
      );
    }
  }
};

const recheck = (preview: ServerPreview, mend: PreviewContext): ServerPreview => {
  switch (preview.mode) {
    case "domain":
      return resolveDomain(preview.domain, preview, false, mend);
    case "tailnet":
      return resolveTailnet(preview, preview.ports, mend);
  }
};

const refuseGatewayPortTaken = (mend: PreviewContext): void => {
  if (mend.ports.includes(PREVIEW_GATEWAY_PORT)) {
    throw setupError(
      `The preview gateway is published on ${PREVIEW_PUBLISHED}, and Mend already publishes port ${PREVIEW_GATEWAY_PORT} (--port, --ssh-port or --t3-gateway-port). Pick another for that one.`,
    );
  }
};

const resolveDomain = (
  domain: string,
  files: PreviewFiles | undefined,
  named: boolean,
  mend: PreviewContext,
): DomainPreview => {
  if (mend.edgeHost === undefined) {
    throw setupError(
      named
        ? "--preview-domain needs the edge (--edge <host>): it is the edge that serves each preview's host over https."
        : `The edge serves previews under ${domain}; without the edge nothing does. Add --no-preview-domain to take them away with the edge.`,
    );
  }
  if (files === undefined) {
    throw setupError(
      `--preview-domain needs --preview-certificate <file> and --preview-key <file>: a certificate for *.${domain} and its key. The packaged edge cannot issue a wildcard; issue one over DNS-01 elsewhere (docs/operations/preview-gateway.md).`,
    );
  }
  const problem = previewDomainProblem(domain, [
    { host: mend.edgeHost, what: "the edge's host" },
    ...mend.hosts,
  ]);
  if (problem !== null) throw setupError(problem);
  refuseGatewayPortTaken(mend);
  if (mend.exposure === "public" && !mend.declared.includes("preview-gateway")) {
    throw setupError(
      `--exposure public with previews under ${domain} needs a statement Mend cannot observe, or Mend refuses to start. Check from another network that *.${domain} resolves to this machine's edge, that https://<label>.${domain} answers over the certificate you supplied and it chains to a public root, and that ${PREVIEW_PUBLISHED} answers nothing from another machine; then add --declare preview-gateway. To check before you state it, turn previews on under --exposure private first.`,
    );
  }
  return { mode: "domain", domain, certificate: files.certificate, key: files.key };
};

const resolveTailnet = (
  saved: TailnetPreview | undefined,
  ports: ReadonlyArray<number>,
  mend: PreviewContext,
): TailnetPreview => {
  if (mend.exposure === "public") {
    throw setupError(
      `Previews on the tailnet are for a private instance: under --exposure public, previews need a registrable domain of their own (--preview-domain, behind the edge), and a tailnet's names are not one. Keep the exposure private, or turn tailnet previews off with --no-preview-tailnet${saved === undefined ? "" : " (they are on now)"}.`,
    );
  }
  refuseGatewayPortTaken(mend);
  const observed = mend.tailnet;
  // Undefined when setup did not look, as when a config is read back: the saved name stands.
  if (observed?._tag === "Refused") throw setupError(observed.problem);
  const hostname = observed?._tag === "Observed" ? observed.hostname : saved?.hostname;
  if (hostname === undefined) {
    throw setupError(
      "Previews on the tailnet take their name from Tailscale on this machine: run mend server setup --preview-tailnet.",
    );
  }
  const own = mend.hosts.find(({ host }) => host === hostname);
  if (own !== undefined)
    throw setupError(
      `${hostname} is ${own.what}, and the preview gateway needs a name of its own on the tailnet. Rename the machine that holds it in Tailscale, then run mend server setup --preview-tailnet again.`,
    );
  const insecure = tailnetAppUrlProblem(mend, observed?._tag === "Observed" ? observed.self : null);
  if (insecure !== null) throw setupError(insecure);
  return { mode: "tailnet", hostname, ports };
};

export interface PreviewPem {
  readonly certificate: string;
  readonly key: string;
}

/**
 * Caddy refuses its whole configuration over a pair it cannot load, taking Mend's own site down
 * with the previews. It loads an expired certificate, which browsers then refuse.
 */
export type PreviewCertificateCheck =
  | { readonly _tag: "Refused"; readonly problem: string }
  | { readonly _tag: "Loaded"; readonly pem: PreviewPem; readonly validTo: Date };

const readPem = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const refused = (problem: string): PreviewCertificateCheck => ({ _tag: "Refused", problem });

export const checkPreviewCertificate = (
  preview: Pick<DomainPreview, "domain" | "certificate" | "key">,
): PreviewCertificateCheck => {
  const certificatePem = readPem(preview.certificate);
  if (certificatePem === null)
    return refused(`${preview.certificate} cannot be read from this machine.`);
  const keyPem = readPem(preview.key);
  if (keyPem === null) return refused(`${preview.key} cannot be read from this machine.`);
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    return refused(`${preview.certificate} holds no PEM certificate.`);
  }
  const wildcard = `dns:*.${preview.domain}`;
  const names = certificate.subjectAltName ?? "";
  if (!names.split(", ").some((name) => name.toLowerCase() === wildcard))
    return refused(
      `${preview.certificate} is not for *.${preview.domain} (its names: ${names === "" ? certificate.subject : names}). Each preview is a host under the domain, so the certificate needs that wildcard.`,
    );
  let matches: boolean;
  try {
    matches = certificate.checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return refused(`${preview.key} holds no PEM private key.`);
  }
  if (!matches) return refused(`${preview.key} is not the key of ${preview.certificate}.`);
  return {
    _tag: "Loaded",
    pem: { certificate: certificatePem, key: keyPem },
    validTo: new Date(certificate.validTo),
  };
};

const RENEW_WITHIN_DAYS = 30;
const RENEWAL = "mend server setup --yes";

/** The supplied pair, loaded; refused when it cannot be, or expired and not already served. */
const loadedCertificate = (
  preview: DomainPreview,
  served: PreviewPem | undefined,
): { readonly pem: PreviewPem; readonly until: string; readonly days: number } => {
  const loaded = checkPreviewCertificate(preview);
  if (loaded._tag === "Refused") throw setupError(loaded.problem);
  const until = loaded.validTo.toISOString();
  const days = (loaded.validTo.getTime() - Date.now()) / 86_400_000;
  if (days <= 0 && served?.certificate !== loaded.pem.certificate)
    throw setupError(
      `${preview.certificate} expired on ${until}. Renew it, then run mend server setup again.`,
    );
  return { pem: loaded.pem, until, days };
};

/** What a run says about previews leaving one mode, before anything is observed. */
const leftLines = (
  before: ServerPreview | undefined,
  after: ServerPreview | undefined,
): ReadonlyArray<string> => {
  if (before === undefined || before.mode === after?.mode) return [];
  switch (before.mode) {
    case "domain":
      return [
        after === undefined
          ? `Previews under ${before.domain} are off: the edge no longer serves them, and the gateway is not listening. The certificate files stay where they are.`
          : `Previews under ${before.domain} move to the tailnet: the edge no longer serves them, and the certificate files stay where they are.`,
      ];
    case "tailnet":
      return after?.mode !== "domain"
        ? []
        : [
            `Previews on the tailnet move to ${after.domain}: tailscale serve on this machine no longer has a gateway for them.`,
          ];
  }
};

export const checkPreview = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
  before: { readonly preview: ServerPreview; readonly pem: PreviewPem | undefined } | undefined,
): Promise<{ readonly pem: PreviewPem | undefined; readonly lines: ReadonlyArray<string> }> => {
  const preview = config.preview;
  const left = leftLines(before?.preview, preview);
  if (preview === undefined) return { pem: undefined, lines: left };
  const certificate = preview.mode === "domain" ? loadedCertificate(preview, before?.pem) : null;
  if (
    before === undefined &&
    config.dockerEndpoint.startsWith("unix://") &&
    runtime.portTaken !== undefined &&
    (await runtime.portTaken(PREVIEW_GATEWAY_PORT, "127.0.0.1"))
  ) {
    throw setupError(
      `${PREVIEW_PUBLISHED} is already in use on this machine, so the preview gateway cannot be published there and Mend would not start. Free it, then run mend server setup again.`,
    );
  }
  if (preview.mode === "tailnet" || certificate === null) return { pem: undefined, lines: left };
  const { pem, until, days } = certificate;
  const line =
    days <= 0
      ? `Observed: ${preview.certificate} expired on ${until}, and browsers refuse every preview until it is renewed. Renew it in place, then run ${RENEWAL} to serve the renewed files.`
      : days <= RENEW_WITHIN_DAYS
        ? `Observed: ${preview.certificate} is for *.${preview.domain} and expires on ${until}, within ${RENEW_WITHIN_DAYS} days. Renew it in place, then run ${RENEWAL} to serve the renewed files.`
        : `Observed: ${preview.certificate} is for *.${preview.domain}, valid until ${until}, and ${preview.key} is its key. Setup copied both into this install; whether the certificate chains to a public root is not checked here. Renew it in place before then, and run ${RENEWAL} to serve the renewed files.`;
  return { pem, lines: [...left, line] };
};

const servedAt = (preview: ServerPreview): string => {
  switch (preview.mode) {
    case "domain":
      return "the edge serves each preview at https://<label>.<domain>";
    case "tailnet":
      return `tailscale serve on this machine serves each preview at https://${preview.hostname}:<port>`;
  }
};

export const observePreviewGateway = async (
  runtime: ServerSetupRuntime,
  preview: ServerPreview,
): Promise<string> => {
  const response = await runtime.fetchText(`http://${PREVIEW_PUBLISHED}/`, 3_000);
  return response.error === undefined &&
    response.status === 404 &&
    response.body.startsWith(NO_SUCH_PREVIEW)
    ? `The preview gateway answered at ${PREVIEW_PUBLISHED}, observed from this machine. Its port is published there only; ${servedAt(preview)}.`
    : `The preview gateway did not answer at ${PREVIEW_PUBLISHED} from this machine. mend server logs shows what Mend said, and mend server status looks again.`;
};

const GATEWAY_UPSTREAM = `http://${PREVIEW_PUBLISHED}/`;

const serveOn = (port: number): string =>
  `  tailscale serve --service=${TAILNET_PREVIEW_SERVICE} --https=${port} --yes http://${PREVIEW_PUBLISHED}`;
const serveOff = (port: number): string =>
  `  tailscale serve --service=${TAILNET_PREVIEW_SERVICE} --https=${port} off`;

const endpointsLine = (ports: ReadonlyArray<number>): string =>
  `In the Tailscale admin console, ${TAILNET_PREVIEW_SERVICE}'s definition lists these endpoints: ${ports.map((port) => `tcp:${port}`).join(",")}`;

/** ADR 0017 decision 6, "What the operator turns on in Tailscale". */
const tailscaleSteps = (preview: TailnetPreview): ReadonlyArray<string> => [
  "What to turn on in Tailscale, once. Mend cannot observe a tailnet's policy, so mend operator exposure lists preview-gateway as open until you check from a device on the tailnet and one outside it, then run mend server setup --declare preview-gateway:",
  `  1. MagicDNS, so ${preview.hostname} resolves on every device.`,
  '  2. HTTPS certificates. Tailscale says that turning them on means "your machine names and your tailnet DNS name will be published on a public ledger".',
  `  3. The Service ${TAILNET_PREVIEW_SERVICE}, defined in the admin console with the endpoints above.`,
  "  4. A tag on this machine: a machine serves a Service only with a tag-based identity.",
  `  5. Approval of this machine for ${TAILNET_PREVIEW_SERVICE}, by an Owner, an Admin or a Network admin, or an auto-approval policy that covers its tag.`,
  `  6. Grants that let the people who open previews reach ${TAILNET_PREVIEW_SERVICE} on these ports.`,
  "Keep Funnel off for these ports: Funnel would open previews to the internet, outside your tailnet's grants.",
];

/**
 * The `tailscale serve` set for the tailnet mode, which setup prints and never runs, as Yiannis
 * decided on 2026-10-28: Mend's container has no tailscaled socket, and the operator runs them. Against what `tailscale serve status` showed for the Service
 * when it was read (`served`), else against the ports saved last time, only what differs.
 */
export const tailnetServeLines = (
  before: ServerPreview | undefined,
  after: ServerPreview | undefined,
  served: ReadonlyArray<ServeRoute> | null,
): ReadonlyArray<string> => {
  const was = before?.mode === "tailnet" ? before : undefined;
  const now = after?.mode === "tailnet" ? after : undefined;
  if (was === undefined && now === undefined) return [];
  const wanted = now?.ports ?? [];
  const servedToGateway =
    served
      ?.filter((route) => route.listener === "https" && route.upstream === GATEWAY_UPSTREAM)
      .map(({ port }) => port) ??
    was?.ports ??
    [];
  const present = served?.map(({ port }) => port) ?? was?.ports ?? [];
  const added = wanted.filter((port) => !servedToGateway.includes(port));
  const dropped = present.filter((port) => !wanted.includes(port));
  const funnel = (served ?? []).filter((route) => route.funnel).map(({ port }) => port);
  const funnelLines =
    funnel.length === 0
      ? []
      : [
          `Observed: Funnel is on for ${TAILNET_PREVIEW_SERVICE} on ${funnel.length === 1 ? "port" : "ports"} ${writePreviewPorts(funnel)}, so ${funnel.length === 1 ? "that preview is" : "those previews are"} open to the internet, not only to your tailnet. Turn Funnel off for ${funnel.length === 1 ? "it" : "them"}.`,
        ];
  const compared =
    served !== null
      ? "against what tailscale serve status on this machine showed"
      : was === undefined
        ? "tailscale serve status was not read here, so every port"
        : "tailscale serve status was not read here, so against the ports setup saved last time";
  const commands = [...added.map(serveOn), ...dropped.map(serveOff)];
  if (now === undefined) {
    return [
      ...(present.length === 0
        ? [
            `Previews on the tailnet are off. Observed: tailscale serve on this machine serves nothing for ${TAILNET_PREVIEW_SERVICE}. Remove the Service in the Tailscale admin console.`,
          ]
        : [
            `Previews on the tailnet are off. Take ${TAILNET_PREVIEW_SERVICE} off tailscale serve: run these on this machine (${compared}):`,
            ...commands,
            `Then remove ${TAILNET_PREVIEW_SERVICE} in the Tailscale admin console.`,
          ]),
      ...funnelLines,
    ];
  }
  const head =
    commands.length === 0
      ? served === null
        ? []
        : [
            `Observed: tailscale serve on this machine serves ${TAILNET_PREVIEW_SERVICE} on ${writePreviewPorts(now.ports)}, every preview port, to the gateway.`,
          ]
      : [
          `Mend's container cannot reach tailscaled, so setup does not run tailscale serve. Run these on this machine (${compared}):`,
          ...commands,
        ];
  if (was !== undefined)
    return [
      ...head,
      ...(writePreviewPorts(was.ports) === writePreviewPorts(now.ports)
        ? []
        : [endpointsLine(now.ports)]),
      ...funnelLines,
    ];
  return [
    `Previews on the tailnet: each at https://${now.hostname}:<port>, a port each from ${writePreviewPorts(now.ports)}, given when a preview is first opened. The gateway listens on ${PREVIEW_PUBLISHED}, and tailscale serve on this machine forwards each port to it.`,
    ...head,
    endpointsLine(now.ports),
    ...tailscaleSteps(now),
    ...funnelLines,
  ];
};

export const previewDomainLine = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
): Promise<string | null> => {
  const edgeHost = config.edgeHost;
  const domain = config.preview?.mode === "domain" ? config.preview.domain : undefined;
  if (edgeHost === undefined || domain === undefined || runtime.lookupHost === undefined)
    return null;
  const probe = `mend-preview-probe.${domain}`;
  const [names, edge] = await Promise.all([
    runtime.lookupHost(probe),
    runtime.lookupHost(edgeHost),
  ]);
  if (names === null || names.length === 0)
    return `Observed: ${probe} does not resolve from this machine. Browsers reach a preview once *.${domain} points where ${edgeHost} does.`;
  const edgeAddresses = edge ?? [];
  return names.every((address) => edgeAddresses.includes(address))
    ? `Observed: ${probe} resolves to ${names.join(", ")}, as ${edgeHost} does.`
    : `Observed: ${probe} resolves to ${names.join(", ")}, and ${edgeHost} to ${edgeAddresses.length === 0 ? "nothing" : edgeAddresses.join(", ")}. Browsers reach a preview once *.${domain} points where ${edgeHost} does.`;
};
