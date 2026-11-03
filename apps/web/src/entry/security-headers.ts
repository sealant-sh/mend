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
 *   string is not part of the match (CSP Level 3, "Does url match expression"). While Mend's app
 *   frames previews (`previewFrameSource`, docs/adr/0017, decision log 15) it also allows
 *   `/preview-auth` on Mend's own origins and the preview hosts that sign-in redirects to. A
 *   frame's redirects are checked against `frame-src` at every hop.
 * - `frame-ancestors 'none'`: nothing may frame Mend. The terminal embed is loaded by the phone's
 *   WebView as a top-level document, which this does not touch. The one exception is
 *   `/preview-auth` while previews frame: `frame-ancestors 'self'`, so only a page of this origin
 *   can frame it, and it answers only with a redirect.
 */
export interface SecurityHeaderInput {
  readonly target: string;
  readonly network: PublicNetwork;
  /** The `frame-src` source of the preview hosts; null while Mend's app frames no preview. */
  readonly previewFrames: string | null;
}

const webSocketOrigin = (appUrl: string): string => {
  const url = new URL(appUrl);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
};

/** The page a preview's frame opens first; it redirects to the preview's own sign-in. */
const PREVIEW_AUTH_PAGE = "/preview-auth";

const frameSources = (
  { allowedOrigins }: PublicNetwork,
  previewFrames: string | null,
): ReadonlyArray<string> => [
  ...allowedOrigins.map((origin) => `${origin}${PAGE_VIEW_PATH}`),
  ...(previewFrames === null
    ? []
    : [...allowedOrigins.map((origin) => `${origin}${PREVIEW_AUTH_PAGE}`), previewFrames]),
];

export const contentSecurityPolicy = (
  network: PublicNetwork,
  previewFrames: string | null,
  framedBy: "none" | "self",
): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' data: ${webSocketOrigin(network.appUrl)}`,
    "worker-src 'self' blob:",
    `frame-src ${frameSources(network, previewFrames).join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors '${framedBy}'`,
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

const CREDENTIAL_PAGES: ReadonlyArray<string> = [
  "/tty-embed",
  "/pair",
  "/authorize",
  PREVIEW_AUTH_PAGE,
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

/** Whether this answer is `/preview-auth` while previews frame: Mend's own pages may frame it. */
const framedBySelf = (input: SecurityHeaderInput): boolean =>
  input.previewFrames !== null && routedPath(requestPathOf(input.target)) === PREVIEW_AUTH_PAGE;

const appHeaders = (input: SecurityHeaderInput): Readonly<Record<string, string>> => ({
  "content-security-policy": contentSecurityPolicy(
    input.network,
    input.previewFrames,
    framedBySelf(input) ? "self" : "none",
  ),
  "x-content-type-options": "nosniff",
  // For browsers that predate frame-ancestors. `SAMEORIGIN` checks only the top-level page in
  // some of them, so the page Mend's app frames carries none.
  ...(framedBySelf(input) ? {} : { "x-frame-options": "DENY" }),
  ...referrerAndCacheHeaders(input.target),
  "permissions-policy": PERMISSIONS_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  ...transportHeaders(input.network.appUrl),
});

/**
 * Headers only the policy sets: the upstream's are dropped even where the policy sets none. The
 * API answers `X-Frame-Options: DENY` everywhere, which would outlive `/preview-auth`'s exception.
 */
export const POLICY_ONLY_HEADERS: ReadonlySet<string> = new Set(["x-frame-options"]);

export const securityHeaders = (input: SecurityHeaderInput): Readonly<Record<string, string>> =>
  isPageViewTarget(input.target)
    ? {
        ...PAGE_VIEW_HEADERS,
        "permissions-policy": PERMISSIONS_POLICY,
        ...transportHeaders(input.network.appUrl),
      }
    : appHeaders(input);
