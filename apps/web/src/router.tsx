import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { TRPCClientError } from "@trpc/client";

import { loginWalk, makeTrpcProxy, trpcClient, TRPCProvider, type TrpcProxy } from "./lib/trpc.ts";
import { routeTree } from "./routeTree.gen";

/** What every route's loader can reach: `context.queryClient` + `context.trpc`. */
export interface RouterAppContext {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
}

/**
 * The official TanStack Start × Query wiring: a QueryClient PER ROUTER (so
 * SSR requests never share a cache), handed to the router context for
 * loaders, with setupRouterSsrQueryIntegration owning provider wrapping and
 * SSR dehydration. The tRPC options proxy rides the same context; components
 * reach it through useTRPC (TRPCProvider in Wrap).
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: 1,
      },
    },
    // An expired session answers 401 on whatever query fires next; walk to
    // /login from ONE place instead of wrapping every queryFn.
    queryCache: new QueryCache({
      onError: (error) => {
        if (
          typeof window !== "undefined" &&
          error instanceof TRPCClientError &&
          error.data?.code === "UNAUTHORIZED"
        ) {
          loginWalk.refused();
        }
      },
    }),
  });
  const trpc = makeTrpcProxy(queryClient);

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient, trpc } satisfies RouterAppContext,
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
