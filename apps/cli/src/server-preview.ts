import { createPrivateKey, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { NO_SUCH_PREVIEW, previewDomainOverlap, SAME_SITE_PREVIEW_REASON } from "@mend/network";

import {
  type DeclarableItem,
  type Exposure,
  PREVIEW_GATEWAY_PORT,
  PREVIEW_PUBLISHED,
  type ServerPreview,
} from "./server-edge.ts";
import { setupError } from "./server-setup-error.ts";
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
    const overlap = previewDomainOverlap(domain, host);
    if (overlap === null) continue;
    switch (overlap.kind) {
      case "holds":
        return `--preview-domain ${domain} holds ${what} ${host}. ${APART}`;
      case "under":
        return `--preview-domain ${domain} is under ${what} ${host}. ${APART}`;
      case "same-site":
        return `--preview-domain ${domain} shares the registrable domain ${overlap.site} with ${what} ${host}, so a page on a preview can set cookies Mend's host receives. ${SAME_SITE_PREVIEW_REASON}`;
    }
  }
  return null;
};

/** The certificate for `*.<domain>` and its key, as absolute paths on this machine. */
export interface PreviewFiles {
  readonly certificate: string;
  readonly key: string;
}

export interface PreviewRequest {
  readonly domain: string | undefined;
  readonly files: PreviewFiles | undefined;
  readonly off: boolean;
}

export const resolvePreview = (
  existing: ServerPreview | undefined,
  request: PreviewRequest,
  mend: {
    readonly edgeHost: string | undefined;
    readonly hosts: ReadonlyArray<{ readonly host: string; readonly what: string }>;
    readonly ports: ReadonlyArray<number>;
    readonly exposure: Exposure | undefined;
    readonly declared: ReadonlyArray<DeclarableItem>;
  },
): ServerPreview | undefined => {
  if (request.off) return undefined;
  const domain = request.domain ?? existing?.domain;
  const files = request.files ?? existing;
  if (domain === undefined) {
    if (files !== undefined)
      throw setupError("--preview-certificate and --preview-key need --preview-domain <domain>.");
    return undefined;
  }
  if (mend.edgeHost === undefined) {
    throw setupError(
      request.domain === undefined
        ? `The edge serves previews under ${domain}; without the edge nothing does. Add --no-preview-domain to take them away with the edge.`
        : "--preview-domain needs the edge (--edge <host>): it is the edge that serves each preview's host over https.",
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
  if (mend.ports.includes(PREVIEW_GATEWAY_PORT)) {
    throw setupError(
      `The preview gateway is published on ${PREVIEW_PUBLISHED}, and Mend already publishes port ${PREVIEW_GATEWAY_PORT} (--port, --ssh-port or --t3-gateway-port). Pick another for that one.`,
    );
  }
  if (mend.exposure === "public" && !mend.declared.includes("preview-gateway")) {
    throw setupError(
      `--exposure public with previews under ${domain} needs a statement Mend cannot observe, or Mend refuses to start. Check from another network that *.${domain} resolves to this machine's edge, that https://<label>.${domain} answers over the certificate you supplied and it chains to a public root, and that ${PREVIEW_PUBLISHED} answers nothing from another machine; then add --declare preview-gateway. To check before you state it, turn previews on under --exposure private first.`,
    );
  }
  return { domain, certificate: files.certificate, key: files.key };
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

export const checkPreviewCertificate = (preview: ServerPreview): PreviewCertificateCheck => {
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

export const checkPreview = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
  before: { readonly preview: ServerPreview; readonly pem: PreviewPem | undefined } | undefined,
): Promise<{ readonly pem: PreviewPem | undefined; readonly lines: ReadonlyArray<string> }> => {
  const preview = config.preview;
  if (preview === undefined)
    return {
      pem: undefined,
      lines:
        before === undefined
          ? []
          : [
              `Previews under ${before.preview.domain} are off: the edge no longer serves them, and the gateway is not listening. The certificate files stay where they are.`,
            ],
    };
  const loaded = checkPreviewCertificate(preview);
  if (loaded._tag === "Refused") throw setupError(loaded.problem);
  const until = loaded.validTo.toISOString();
  const left = (loaded.validTo.getTime() - Date.now()) / 86_400_000;
  const served = before?.pem?.certificate === loaded.pem.certificate;
  if (left <= 0 && !served)
    throw setupError(
      `${preview.certificate} expired on ${until}. Renew it, then run mend server setup again.`,
    );
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
  const line =
    left <= 0
      ? `Observed: ${preview.certificate} expired on ${until}, and browsers refuse every preview until it is renewed. Renew it in place, then run ${RENEWAL} to serve the renewed files.`
      : left <= RENEW_WITHIN_DAYS
        ? `Observed: ${preview.certificate} is for *.${preview.domain} and expires on ${until}, within ${RENEW_WITHIN_DAYS} days. Renew it in place, then run ${RENEWAL} to serve the renewed files.`
        : `Observed: ${preview.certificate} is for *.${preview.domain}, valid until ${until}, and ${preview.key} is its key. Setup copied both into this install; whether the certificate chains to a public root is not checked here. Renew it in place before then, and run ${RENEWAL} to serve the renewed files.`;
  return { pem: loaded.pem, lines: [line] };
};

export const observePreviewGateway = async (runtime: ServerSetupRuntime): Promise<string> => {
  const response = await runtime.fetchText(`http://${PREVIEW_PUBLISHED}/`, 3_000);
  return response.error === undefined &&
    response.status === 404 &&
    response.body.startsWith(NO_SUCH_PREVIEW)
    ? `The preview gateway answered at ${PREVIEW_PUBLISHED}, observed from this machine. Its port is published there only; the edge serves each preview at https://<label>.<domain>.`
    : `The preview gateway did not answer at ${PREVIEW_PUBLISHED} from this machine. mend server logs shows what Mend said, and mend server status looks again.`;
};

export const previewDomainLine = async (
  runtime: ServerSetupRuntime,
  config: ServerConfig,
): Promise<string | null> => {
  const edgeHost = config.edgeHost;
  const domain = config.preview?.domain;
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
