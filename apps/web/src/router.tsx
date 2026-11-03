import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { TRPCClientError } from "@trpc/client";
import { deserialize, serialize } from "superjson";

import { followOtherTabs } from "./components/session-message-input.tsx";
import {
  loginWalk,
  makeTrpcClient,
  makeTrpcProxy,
  TRPCProvider,
  type TrpcClient,
  type TrpcProxy,
} from "./lib/trpc.ts";
import { routeTree } from "./routeTree.gen";

/** What every route's loader can reach: `context.queryClient`, `context.trpc` and `context.trpcClient`. */
export interface RouterAppContext {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
  readonly trpcClient: TrpcClient;
}

/**
 * The official TanStack Start × Query wiring: a QueryClient and a tRPC client
 * PER ROUTER (so SSR requests never share a cache or a cookie), handed to the router context for
 * loaders, with setupRouterSsrQueryIntegration owning provider wrapping and
 * SSR dehydration. The tRPC options proxy rides the same context; components
 * reach it through useTRPC (TRPCProvider in Wrap).
 */
const walkToLoginOn401 = (error: unknown) => {
  if (
    typeof window !== "undefined" &&
    error instanceof TRPCClientError &&
    error.data?.code === "UNAUTHORIZED"
  ) {
    loginWalk.refused();
  }
};

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
      },
      // tRPC's transformer carries the cache from the server render to the browser too.
      dehydrate: { serializeData: serialize },
      hydrate: { deserializeData: deserialize },
    },
    // An expired session answers 401 on whatever query fires next; walk to
    // /login from ONE place instead of wrapping every queryFn.
    queryCache: new QueryCache({ onError: walkToLoginOn401 }),
    // The same for a mutation made through `useMutation`, so a save after the session expired
    // walks to sign-in instead of showing "UNAUTHORIZED" beside the control.
    mutationCache: new MutationCache({ onError: walkToLoginOn401 }),
  });
  const trpcClient = makeTrpcClient();
  const trpc = makeTrpcProxy(queryClient, trpcClient);
  if (typeof window !== "undefined") followOtherTabs(queryClient);

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient, trpc, trpcClient } satisfies RouterAppContext,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    Wrap: ({ children }) => (
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    ),
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}
