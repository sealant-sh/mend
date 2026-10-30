import {
  HANDED_LINK_PAGE_PATHS,
  isPageViewTarget,
  PAGE_VIEW_HEADERS,
  PAGE_VIEW_PATH,
  type PublicNetwork,
  requestPathOf,
  routedPath,
} from "@mend/network";

/**
 * The browser header policy (docs/adr/0004, "Errors and browser headers"; MEND-11). Set by the
 * front on every response it relays, the app's and the API's alike, so there is one policy and one
 * place to read it. A header the upstream already set is replaced: the front is the authority.
 *
 * What the Content-Security-Policy allows, and why:
 * - `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`. The terminal is WebAssembly. The
 *   document carries inline scripts (the no-flash theme bootstrap and the framework's hydration
 *   payload), so inline is allowed until those carry a nonce (ADR 0004, decision 13). No other
 *   origin may supply a script, so an injected `<script src>` loads nothing.
 * - `connect-src` names this origin's own ws(s) address as well as `'self'`, because not every
 *   browser reads `'self'` as covering WebSockets. It also allows `data:`: the terminal library
 *   ships its WebAssembly inlined as a `data:` URL and loads it with `fetch`, which `connect-src`
 *   governs. A `data:` fetch reaches no server, so it carries nothing out; without it the terminal
 *   and `/tty-embed` load nothing (observed in Chromium; security-headers.test.ts pins it to how
 *   the installed library loads).
 * - `frame-src`: a source with a path and no trailing slash matches only that path; the query
 *   string is not part of the match (CSP Level 3, "Does url match expression").
 * - `frame-ancestors 'none'`: nothing may frame Mend. The terminal embed is loaded by the phone's
 *   WebView as a top-level document, which this does not touch.
 */
export interface SecurityHeaderInput {
  readonly target: string;
  readonly network: PublicNetwork;
}

const webSocketOrigin = (appUrl: string): string => {
  const url = new URL(appUrl);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
};

export const contentSecurityPolicy = ({ appUrl, allowedOrigins }: PublicNetwork): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' data: ${webSocketOrigin(appUrl)}`,
    "worker-src 'self' blob:",
    `frame-src ${allowedOrigins.map((origin) => `${origin}${PAGE_VIEW_PATH}`).join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

/** Every browser feature Mend does not use, off. Clipboard stays: the terminal pastes. */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
  "browsing-topics=()",
].join(", ");

/**
 * Pages whose URL carries a credential (an upgrade ticket, a pairing or authorization code, a
 * preview grant, a handed-over link's secret): nothing about them may leave in a Referer or stay in
 * a cache. Matched as the routers match a path, with any path below each for the older link forms.
 */
const CREDENTIAL_PAGES: ReadonlyArray<string> = [
  "/tty-embed",
  "/pair",
  "/authorize",
  "/preview-auth",
  "/api/preview-auth",
  ...HANDED_LINK_PAGE_PATHS,
];

const referrerAndCacheHeaders = (target: string): Readonly<Record<string, string>> => {
  const pathname = routedPath(requestPathOf(target));
  return CREDENTIAL_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`))
    ? { "referrer-policy": "no-referrer", "cache-control": "no-store" }
    : { "referrer-policy": "strict-origin-when-cross-origin" };
};

/**
 * Only over https: on plain http the header is ignored by browsers and would be a false claim. For
 * this host only: `includeSubDomains` on an apex `APP_URL` would pin every sibling host the
 * operator runs to https for a year, which is not Mend's to decide.
 */
const transportHeaders = (appUrl: string): Readonly<Record<string, string>> =>
  appUrl.startsWith("https://") ? { "strict-transport-security": "max-age=31536000" } : {};

const appHeaders = (input: SecurityHeaderInput): Readonly<Record<string, string>> => ({
  "content-security-policy": contentSecurityPolicy(input.network),
  "x-content-type-options": "nosniff",
  // For browsers that predate frame-ancestors.
  "x-frame-options": "DENY",
  ...referrerAndCacheHeaders(input.target),
  "permissions-policy": PERMISSIONS_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  ...transportHeaders(input.network.appUrl),
});

export const securityHeaders = (input: SecurityHeaderInput): Readonly<Record<string, string>> =>
  isPageViewTarget(input.target)
    ? {
        ...PAGE_VIEW_HEADERS,
        "permissions-policy": PERMISSIONS_POLICY,
        ...transportHeaders(input.network.appUrl),
      }
    : appHeaders(input);
