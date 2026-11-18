/** The exchange refused the ticket this page holds: only the app that embedded it can mint another. */
export class EmbedTicketRefused extends Error {
  constructor(status: number) {
    super(`the terminal ticket was refused (${status})`);
    this.name = "EmbedTicketRefused";
  }
}

/** What the page posts to the app that embeds it when its ticket is refused. */
export const EMBED_EXPIRED_MESSAGE = "mend:embed-expired";

/**
 * Tells the embedding app (a React Native WebView, or a parent frame) that this page can no longer
 * reconnect, so it loads the embed again with a fresh ticket. A page with no such host just keeps
 * its reconnect ladder.
 */
export const notifyEmbedExpired = () => {
  const host: unknown = Reflect.get(window, "ReactNativeWebView");
  if (typeof host === "object" && host !== null && "postMessage" in host) {
    const { postMessage } = host;
    if (typeof postMessage === "function") postMessage.call(host, EMBED_EXPIRED_MESSAGE);
  }
  if (window.parent !== window) window.parent.postMessage(EMBED_EXPIRED_MESSAGE, "*");
};

/**
 * The embed page's credential chain (docs/adr/0004, "Upgrade tickets"). The first trade spends the
 * ticket from the page's URL and answers a socket ticket and a renewal ticket; later trades show
 * that renewal, which is kept, so a reply lost on the way back strands nobody. The renewal ticket
 * lives here, in memory, and travels only in a request body. It ends twelve hours after the app
 * minted the URL, or with the sign-in or device that minted it.
 */
export const makeEmbedExchange = (
  embedTicket: string,
  address: { readonly session: string } | { readonly process: string },
  send: typeof fetch = fetch,
) => {
  let current = embedTicket;
  return {
    next: async (): Promise<string> => {
      const response = await send("/api/upgrade-tickets/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: current, ...address }),
      });
      if (response.status === 401) throw new EmbedTicketRefused(response.status);
      if (!response.ok) throw new Error(`the terminal ticket trade failed (${response.status})`);
      const traded: unknown = await response.json();
      if (
        typeof traded !== "object" ||
        traded === null ||
        !("ticket" in traded) ||
        !("renew" in traded) ||
        typeof traded.ticket !== "string" ||
        typeof traded.renew !== "string"
      ) {
        throw new Error("the terminal ticket answer was malformed");
      }
      current = traded.renew;
      return traded.ticket;
    },
  };
};
