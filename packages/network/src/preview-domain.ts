import { getDomain } from "tldts";

/**
 * How a preview domain sits against one of Mend's hosts (docs/adr/0017, decision 1). Equal to it,
 * above it or under it, a page on a preview could act as Mend's own site. Beside it on the same
 * registrable domain, a page on a preview can set cookies for that domain, which Mend's host
 * receives but cannot mistake for its own `__Host-` cookies.
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

/** The overlaps that refuse a preview domain: equal to one of Mend's hosts, above it or under it. */
export type PreviewDomainConflict = Exclude<PreviewDomainOverlap, { readonly kind: "same-site" }>;

/**
 * A preview domain beside Mend's host on one registrable domain is allowed: decided by Yiannis,
 * 2026-10-29 (ADR 0017, decision 1). Mend's cookies are `__Host-` on every https APP_URL, so a
 * page on such a preview can neither set nor replace them, and Mend refuses a cookie-bearing
 * request from a sibling site.
 */
export const previewDomainConflict = (
  domain: string,
  host: string,
): PreviewDomainConflict | null => {
  const overlap = previewDomainOverlap(domain, host);
  return overlap === null || overlap.kind === "same-site" ? null : overlap;
};

/** What the preview gateway answers, with 404, for a Host it serves no preview for. */
export const NO_SUCH_PREVIEW = "No such preview.";
