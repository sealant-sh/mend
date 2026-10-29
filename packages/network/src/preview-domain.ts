import { getDomain } from "tldts";

/**
 * How a preview domain sits against one of Mend's hosts (docs/adr/0017, decision 1). Equal to it,
 * above it or under it, a page on a preview could act as Mend's own site. Beside it on the same
 * registrable domain, a page on a preview can set cookies for that domain, and Mend's host
 * receives them.
 */
export type PreviewDomainOverlap =
  | { readonly kind: "holds" }
  | { readonly kind: "under" }
  | { readonly kind: "same-site"; readonly site: string };

/** The registrable domain a browser computes, private suffixes such as github.io included. */
const registrableDomain = (host: string): string | null =>
  getDomain(host, { allowPrivateDomains: true });

export const previewDomainOverlap = (domain: string, host: string): PreviewDomainOverlap | null => {
  if (host === domain || host.endsWith(`.${domain}`)) return { kind: "holds" };
  if (domain.endsWith(`.${host}`)) return { kind: "under" };
  const site = registrableDomain(domain);
  return site !== null && site === registrableDomain(host) ? { kind: "same-site", site } : null;
};

export const SAME_SITE_PREVIEW_REASON =
  "Previews on Mend's own site need Mend's cookies to move to __Host- names, which ships in ADR 0017 step 8b with the tailnet default. Until then, use a preview domain on a registrable domain of its own, or loopback (*.localhost).";

/** What the preview gateway answers, with 404, for a Host it serves no preview for. */
export const NO_SUCH_PREVIEW = "No such preview.";
