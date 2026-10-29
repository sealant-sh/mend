import {
  cookieValues,
  isAllowedOrigin,
  type PublicNetwork,
  sessionCookieName,
  SIBLING_SITE_REFUSAL,
  siblingSiteRefused,
} from "@mend/network";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "./routers/index.ts";

/**
 * Validate the browser's source request before any procedure runs. The API also
 * receives Origin unchanged, so server transport cannot launder cookie authority.
 * It does not receive Fetch Metadata, so the sibling-site check runs here too.
 * Native callers without cookies or Origin still use the usual authentication.
 */
export const createTrpcHandler =
  (options: {
    readonly network: PublicNetwork;
    readonly apiUrl: string;
  }): ((request: Request) => Promise<Response>) =>
  async (request) => {
    const origin = request.headers.get("origin");
    if (
      origin === null
        ? request.method !== "GET" && request.headers.has("cookie")
        : !isAllowedOrigin(options.network, origin)
    ) {
      return new Response("Origin not allowed", { status: 403 });
    }
    if (
      siblingSiteRefused(options.network, {
        method: request.method,
        upgrade: request.headers.has("upgrade"),
        origin: origin ?? undefined,
        sessionCookie:
          cookieValues(
            request.headers.get("cookie") ?? undefined,
            sessionCookieName(options.network.appUrl),
          ).length > 0,
        fetchSite: request.headers.get("sec-fetch-site") ?? undefined,
        fetchMode: request.headers.get("sec-fetch-mode") ?? undefined,
        fetchDest: request.headers.get("sec-fetch-dest") ?? undefined,
      })
    ) {
      return new Response(SIBLING_SITE_REFUSAL, { status: 403 });
    }
    return fetchRequestHandler({
      endpoint: "/trpc",
      req: request,
      router: appRouter,
      createContext: () => ({ headers: request.headers, apiUrl: options.apiUrl }),
    });
  };
