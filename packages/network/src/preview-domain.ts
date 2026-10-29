import { getDomain } from "tldts";

import type { SessionCookiePrefix } from "./session-cookie.ts";

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

/**
 * How a preview domain conflicts with one of Mend's hosts: equal to it, above it or under it,
 * always; beside it on one registrable domain, only while `cookies` is not `__Host-` (ADR 0017,
 * decision 1). With `__Host-` a page on such a preview can neither set nor replace Mend's cookie;
 * over http it can plant one for the whole site that Mend reads as its own.
 */
export const previewDomainConflict = (
  domain: string,
  host: string,
  cookies: SessionCookiePrefix,
): PreviewDomainOverlap | null => {
  const overlap = previewDomainOverlap(domain, host);
  return overlap?.kind === "same-site" && cookies === "__Host-" ? null : overlap;
};

/** What the preview gateway answers, with 404, for a Host it serves no preview for. */
export const NO_SUCH_PREVIEW = "No such preview.";
