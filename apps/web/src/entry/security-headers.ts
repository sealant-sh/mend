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
 * - `frame-ancestors 'none'`: nothing may frame Mend. The terminal embed is loaded by the phone's
 *   WebView as a top-level document, which this does not touch.
 */
export interface SecurityHeaderInput {
  /** The request's path, for the few paths that differ. */
  readonly pathname: string;
  /** The exact browser origin (`APP_URL`). */
  readonly appUrl: string;
}

const webSocketOrigin = (appUrl: string): string => {
  const url = new URL(appUrl);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
};

export const contentSecurityPolicy = (appUrl: string): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' data: ${webSocketOrigin(appUrl)}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

/** Every browser feature Mend does not use, off. Clipboard stays: the terminal pastes. */
const PERMISSIONS_POLICY = [
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

/** Pages whose URL carries a credential: nothing about them may leave in a Referer. */
const isCredentialedPage = (pathname: string): boolean =>
  pathname === "/tty-embed" || pathname === "/pair" || pathname === "/authorize";

export const securityHeaders = (input: SecurityHeaderInput): Readonly<Record<string, string>> => ({
  "content-security-policy": contentSecurityPolicy(input.appUrl),
  "x-content-type-options": "nosniff",
  // For browsers that predate frame-ancestors.
  "x-frame-options": "DENY",
  "referrer-policy": isCredentialedPage(input.pathname)
    ? "no-referrer"
    : "strict-origin-when-cross-origin",
  "permissions-policy": PERMISSIONS_POLICY,
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  // Only over https: on plain http the header is ignored by browsers and would be a false claim.
  // For this host only: `includeSubDomains` on an apex `APP_URL` would pin every sibling host the
  // operator runs to https for a year, which is not Mend's to decide.
  ...(input.appUrl.startsWith("https://")
    ? { "strict-transport-security": "max-age=31536000" }
    : {}),
});
