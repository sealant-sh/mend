/**
 * WebSocket URLs for the three data planes (docs/adr/0004, "Upgrade tickets"; MEND-08). A
 * WebSocket opened from here cannot set an Authorization header, so the credential rides the URL,
 * and what rides it is an upgrade ticket: single use, thirty seconds, good for exactly this target
 * and these parameters. The saved token goes to the server in a header, over the API, and never in
 * a URL.
 */
export type UpgradeTarget = "tty" | "service-tunnel" | "keys-bridge";

export interface UpgradeParams {
  readonly process?: string;
  readonly session?: string;
  readonly service?: string;
  readonly host?: string;
}

/** Mints one ticket: `POST /api/upgrade-tickets` with the caller's credentials in a header. */
export type MintTicket = (
  target: UpgradeTarget,
  params: UpgradeParams,
) => Promise<
  { readonly kind: "ticket"; readonly ticket: string } | { readonly kind: "unsupported" }
>;

const PATHS: Readonly<Record<UpgradeTarget, string>> = {
  tty: "/api/tty",
  "service-tunnel": "/api/service-tunnel",
  "keys-bridge": "/api/keys/bridge/ws",
};

/** The target's ws(s) URL with its addressing parameters and no credential. */
export const upgradeBaseUrl = (
  serverUrl: string,
  target: UpgradeTarget,
  params: UpgradeParams,
  extra: Readonly<Record<string, string>> = {},
): URL => {
  const url = new URL(`${serverUrl.replace(/\/$/, "")}${PATHS[target]}`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of Object.entries({ ...params, ...extra })) {
    if (typeof value === "string" && value !== "") url.searchParams.set(key, value);
  }
  return url;
};

/**
 * What a 404 from the mint means. A server older than tickets has no such route, and its `/health`
 * does not mention them. A server that has them says so, and then the 404 came from something in
 * between (a proxy, a WAF rule): the saved token must not start riding URLs that every hop logs
 * because of it.
 */
export const mintRefusedInTransit = async (
  serverUrl: string,
  send: typeof fetch = fetch,
): Promise<boolean> => {
  try {
    const response = await send(`${serverUrl.replace(/\/$/, "")}/api/health`);
    if (!response.ok) return false;
    const health: unknown = await response.json();
    return (
      typeof health === "object" &&
      health !== null &&
      "upgradeTickets" in health &&
      health.upgradeTickets === true
    );
  } catch {
    return false;
  }
};

export const MINT_REFUSED_IN_TRANSIT =
  "POST /api/upgrade-tickets answered 404, but this server mints upgrade tickets: something between this client and Mend is refusing it. The saved token was not put in a URL.";

/**
 * A URL ready to connect, with a fresh ticket. Tickets are single use, so every connection
 * (and every reconnect) asks again.
 *
 * A server older than tickets answers the mint with 404. Only then does the saved token go in the
 * URL, as it always did with that server; a server that knows tickets never sees it there.
 */
export const upgradeUrl = async (input: {
  readonly serverUrl: string;
  readonly target: UpgradeTarget;
  readonly params: UpgradeParams;
  readonly extra?: Readonly<Record<string, string>>;
  readonly mint: MintTicket;
  readonly legacyToken: string | null;
}): Promise<URL> => {
  const url = upgradeBaseUrl(input.serverUrl, input.target, input.params, input.extra);
  const minted = await input.mint(input.target, input.params);
  if (minted.kind === "ticket") url.searchParams.set("ticket", minted.ticket);
  else if (input.legacyToken !== null) url.searchParams.set("token", input.legacyToken);
  return url;
};
