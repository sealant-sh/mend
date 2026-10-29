import { isAllowedOrigin, type PublicNetwork } from "./public-network.ts";

export interface BrowserRequest {
  readonly method: string;
  readonly upgrade: boolean;
  readonly fetchSite: string | undefined;
  readonly fetchMode: string | undefined;
  readonly fetchDest: string | undefined;
}

/**
 * A top-level document navigation by GET only: a form's POST from a sibling site is refused like
 * any subrequest, and no browser navigates by HEAD.
 */
export const isDocumentNavigation = (head: BrowserRequest): boolean =>
  head.method === "GET" &&
  !head.upgrade &&
  head.fetchMode === "navigate" &&
  head.fetchDest === "document";

/**
 * The sibling-site rule, for Mend's own routes and for the preview gateway alike (docs/adr/0017):
 * a request from another site, or from a sibling host on the same site (a preview on a tailnet's
 * `ts.net` name), passes only as a top-level document navigation. `SameSite=Lax` sends cookies on
 * same-site subrequests, so an image or a `fetch` from a sibling page would otherwise carry them.
 * A browser that sends no Fetch Metadata, such as Safari before 16.4, is not checked here.
 */
export const siblingRequestAdmitted = (head: BrowserRequest): boolean =>
  (head.fetchSite !== "same-site" && head.fetchSite !== "cross-site") || isDocumentNavigation(head);

export interface BrowserSource extends BrowserRequest {
  readonly origin: string | undefined;
  /** Whether the request carries Mend's session cookie, by its exact name. */
  readonly sessionCookie: boolean;
}

export const siblingSiteRefused = (network: PublicNetwork, source: BrowserSource): boolean =>
  source.sessionCookie &&
  !(source.origin !== undefined && isAllowedOrigin(network, source.origin)) &&
  !siblingRequestAdmitted(source);

export const SIBLING_SITE_REFUSAL = "Cross-site request refused";
