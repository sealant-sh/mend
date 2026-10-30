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
