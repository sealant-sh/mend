import { Config, Effect } from "effect";

import { previewDomainOverlap } from "./preview-domain.ts";
import type { PublicNetwork } from "./public-network.ts";

/**
 * Where the preview gateway places previews, as far as framing them goes (docs/adr/0017, decision
 * log 15). A loopback preview at `<label>.localhost` is on a site of its own.
 */
export type PreviewPlacement =
  | { readonly mode: "loopback-http" }
  | { readonly mode: "domain-https"; readonly domain: string; readonly port: number }
  | { readonly mode: "tailnet-https"; readonly hostname: string };

/**
 * The site a preview shares with `appUrl` when Mend's app shows it in a frame; null when it does
 * not. A preview framed from another site cannot keep its sign-in: its grant cookie is
 * `SameSite=Lax`, which a browser neither sets nor sends in a cross-site frame, and Safari and
 * Firefox block or partition a cross-site frame's cookies besides. Over http Mend refuses a preview
 * domain on its own site (decision 1), so only https frames.
 */
export const previewFrameSite = (
  placement: PreviewPlacement | null,
  appUrl: string,
): string | null => {
  if (placement === null || placement.mode === "loopback-http") return null;
  const app = new URL(appUrl);
  if (app.protocol !== "https:") return null;
  const host = placement.mode === "domain-https" ? placement.domain : placement.hostname;
  const overlap = previewDomainOverlap(host, app.hostname);
  return overlap?.kind === "same-site" ? overlap.site : null;
};

/** The `frame-src` source matching every preview origin, while Mend's app frames them. */
export const previewFrameSource = (
  placement: PreviewPlacement | null,
  appUrl: string,
): string | null => {
  if (placement === null || previewFrameSite(placement, appUrl) === null) return null;
  switch (placement.mode) {
    case "loopback-http":
      return null;
    case "domain-https":
      return `https://*.${placement.domain}${placement.port === 443 ? "" : `:${placement.port}`}`;
    case "tailnet-https":
      // A port per preview, from a set the operator can change while the web tier runs.
      return `https://${placement.hostname}:*`;
  }
};

/**
 * The `frame-ancestors` every answer of the preview gateway carries: the preview itself, for an
 * app that frames its own pages, and Mend's own app at each of its origins. No other page, a
 * sibling preview included, may frame a preview.
 */
export const previewFrameAncestors = (network: PublicNetwork): string =>
  ["frame-ancestors 'self'", ...network.allowedOrigins].join(" ");

const variable = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim()),
  );

/**
 * The placement from the variables the API reads (`MEND_PREVIEW_DOMAIN`,
 * `MEND_PREVIEW_PUBLIC_PORT`, `MEND_PREVIEW_TAILNET_HOSTNAME`), for the web tier's browser policy.
 * The API checks them and refuses to start on a bad one; this reads them as the API decides
 * between them: a domain takes over from a tailnet hostname.
 */
export const loadPreviewPlacement: Effect.Effect<PreviewPlacement | null, Config.ConfigError> =
  Effect.gen(function* () {
    const domain = yield* variable("MEND_PREVIEW_DOMAIN");
    const publicPort = yield* variable("MEND_PREVIEW_PUBLIC_PORT");
    const hostname = yield* variable("MEND_PREVIEW_TAILNET_HOSTNAME");
    if (domain !== "") {
      return {
        mode: "domain-https",
        domain,
        port: /^[0-9]{1,5}$/.test(publicPort) ? Number(publicPort) : 443,
      };
    }
    return hostname === "" ? null : { mode: "tailnet-https", hostname };
  });
