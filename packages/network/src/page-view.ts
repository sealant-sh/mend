// The CSP `sandbox` directive without `allow-same-origin` runs the page in an opaque origin,
// framed or top-level, so it reads no cookie or storage of Mend's origin. Mend's app frames it, so
// this route alone sets no `X-Frame-Options` and no `frame-ancestors` (docs/adr/0004).
export const PAGE_VIEW_PATH = "/api/page-view";

export const PAGE_VIEW_TOKEN_PARAM = "view";

export const PAGE_VIEW_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "sandbox allow-scripts allow-forms",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
};

/**
 * Not a WHATWG `URL`: it would resolve `/api/auth/%2e%2e/page-view` to the page view's path while
 * the router serves Better Auth's.
 */
export const requestPathOf = (target: string): string =>
  target.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#;]/, 1)[0] ?? "";

/**
 * The path as Effect's HttpRouter will match it. The router ignores case and duplicate slashes and
 * decodes percent-escapes, so a spelling that still reaches a route must not slip past a rule.
 */
export const routedPath = (pathname: string): string => {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Not valid escapes: the router will not match it either.
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/");
};

export const isPageViewTarget = (target: string): boolean =>
  requestPathOf(target) === PAGE_VIEW_PATH;
