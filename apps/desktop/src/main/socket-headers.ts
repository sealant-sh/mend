/**
 * The renderer's terminal socket as the server should see it: a native token client, not a
 * browser page.
 *
 * Chromium stamps every WebSocket upgrade with the page's Origin — `file://` from a packaged
 * build, `http://localhost:5173` in dev. Neither is a public origin an operator configures, and
 * the server's public-network policy refuses an upgrade whose Origin it does not list
 * ("403 Origin not allowed"). An upgrade with no Origin and no cookie goes on to authentication,
 * the same path the CLI and the phone take; the upgrade ticket main minted is the credential.
 * So for sockets to the configured Mend server, main drops the Origin and any Cookie before the
 * request leaves. It never adds a credential. Requests anywhere else pass untouched.
 */

/** The request header names this module removes, lowercased. */
const BROWSER_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["origin", "cookie"]);

const socketProtocolFor = (httpProtocol: string): string | null =>
  httpProtocol === "https:" ? "wss:" : httpProtocol === "http:" ? "ws:" : null;

const parse = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * Whether `requestUrl` is a WebSocket to the Mend server at `serverUrl`: the matching socket
 * scheme (`https:` → `wss:`), the same host and port, and a path under the server's `/api/`.
 */
export const isMendSocket = (requestUrl: string, serverUrl: string): boolean => {
  const request = parse(requestUrl);
  const server = parse(serverUrl.trim());
  if (request === null || server === null) return false;
  const protocol = socketProtocolFor(server.protocol);
  if (protocol === null || request.protocol !== protocol) return false;
  if (request.host !== server.host) return false;
  const base = server.pathname.replace(/\/+$/, "");
  return request.pathname.startsWith(`${base}/api/`);
};

/** The same headers without Origin and Cookie, whatever their case. */
export const withoutBrowserCredentials = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !BROWSER_CREDENTIAL_HEADERS.has(name.toLowerCase())),
  );

/** The URL patterns worth inspecting: sockets only, so page assets never reach the listener. */
export const SOCKET_URL_PATTERNS: ReadonlyArray<string> = ["ws://*/*", "wss://*/*"];
