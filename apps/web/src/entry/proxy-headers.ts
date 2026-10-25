import type * as http from "node:http";

/** Request facts the web proxy forwards to its internal app and API servers. */
export interface ProxyRequestMetadata {
  /** Headers received from the client-facing connection. */
  readonly headers: http.IncomingHttpHeaders;
  /** Address observed on that connection. */
  readonly remoteAddress: string | undefined;
}

/**
 * Keep same-origin request headers while removing client-written address metadata.
 * The client chain remains only for rate limiting, with this proxy's observation appended.
 */
export const forwardHeaders = (request: ProxyRequestMetadata): http.OutgoingHttpHeaders => {
  const priorFor = request.headers["x-forwarded-for"];
  const headers: http.OutgoingHttpHeaders = { ...request.headers };
  delete headers["forwarded"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  return {
    ...headers,
    "x-forwarded-for": [
      Array.isArray(priorFor) ? priorFor.join(", ") : priorFor,
      request.remoteAddress,
    ]
      .filter(Boolean)
      .join(", "),
  };
};

const API_ALIASES = ["/preview-auth"] as const;

export const apiTargetOf = (url: string): string | null => {
  if (url === "/api" || url.startsWith("/api/")) return url;
  const alias = API_ALIASES.find((path) => url === path || url.startsWith(`${path}?`));
  return alias === undefined ? null : `/api${url}`;
};

/** httpxy prefixes a route's target path to the request's, so an alias's target ends in `/api`. */
export const devProxyRoutes = (
  apiTarget: string,
): Readonly<Record<string, { readonly target: string }>> => ({
  "/api/**": { target: apiTarget },
  ...Object.fromEntries(
    API_ALIASES.map((path) => [path, { target: `${apiTarget.replace(/\/$/, "")}/api` }]),
  ),
});
