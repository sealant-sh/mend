import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  splitLink,
  TRPCClientError,
  type TRPCLink,
  unstable_localLink,
} from "@trpc/client";
import { createTRPCContext, createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";

import type { TrpcContext } from "../server/api/run.ts";
import { appRouter, type AppRouter } from "../server/routers/index.ts";
import { makeLoginWalk } from "./login-walk.ts";
import { withContinuation } from "./onboarding.ts";

/**
 * Calls that go out alone, never in a batch: a batch answers when its slowest call does, so one
 * that reads a worktree (`sessions.recipes`, and `changes.stats` for an inbox row's `+N −M`; seconds
 * on a heavy one or a busy server) would hold back the viewer, the composer and every other quick
 * read beside it.
 */
export const UNBATCHED_PATHS: ReadonlySet<string> = new Set(["sessions.recipes", "changes.stats"]);

type TrpcFetch = NonNullable<Parameters<typeof httpLink>[0]["fetch"]>;

/**
 * The browser's links to the web tier's /trpc. superjson matches the server's transformer, so
 * Dates, bigints and branded ids arrive as themselves; the cookie goes by itself.
 */
export const trpcLinks = (url: string, fetch?: TrpcFetch): TRPCLink<AppRouter>[] => {
  const options = {
    url,
    transformer: superjson,
    methodOverride: "POST",
    ...(fetch === undefined ? {} : { fetch }),
  } satisfies Parameters<typeof httpLink<AppRouter>>[0];
  return [
    splitLink({
      condition: (op) => UNBATCHED_PATHS.has(op.path),
      true: httpLink(options),
      // A batch's URL names every procedure in it; maxURLLength splits a big
      // one instead of overflowing URL limits.
      false: httpBatchLink({ ...options, maxURLLength: 2083 }),
    }),
  ];
};

/**
 * A procedure called while a page renders on the server speaks for that page's request: its
 * cookie and client chain, with the app's own Origin, which the API's source check requires of a
 * cookie-bearing call and a page navigation does not carry.
 */
const pageRequestContext = (request: Request): TrpcContext => {
  const headers = new Headers(request.headers);
  headers.set("origin", new URL(process.env["APP_URL"] ?? "http://localhost:3105").origin);
  return {
    headers,
    apiUrl: new URL(process.env["MEND_API_URL"] ?? "http://localhost:3101").origin,
  };
};

let browserClient: ReturnType<typeof createTRPCClient<AppRouter>> | undefined;

/**
 * The browser's one client: its router's, and the one event handlers outside React reach. It
 * carries no credentials of its own, so outside a browser (a test in Node) it reaches this web
 * server's port as nobody.
 */
export const browserTrpcClient = () =>
  (browserClient ??= createTRPCClient<AppRouter>({
    links: trpcLinks(
      typeof window === "undefined"
        ? `http://localhost:${process.env["PORT"] ?? "3105"}/trpc`
        : "/trpc",
    ),
  }));

/**
 * The client for one router (TanStack Start × tRPC: create it in `getRouter`). On the server it
 * calls procedures in this process (`localLink`), each call with the context of the request being
 * rendered, so no call can carry another request's cookie. In the browser it is the page's one
 * client.
 */
export const makeTrpcClient = createIsomorphicFn()
  .server(() =>
    createTRPCClient<AppRouter>({
      links: [
        unstable_localLink({
          router: appRouter,
          transformer: superjson,
          createContext: async () => pageRequestContext(getRequest()),
        }),
      ],
    }),
  )
  .client(() => browserTrpcClient());
export type TrpcClient = ReturnType<typeof browserTrpcClient>;

/** Hook-side access (components): `const trpc = useTRPC()` → queryOptions/mutationOptions. */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** Router-context access (loaders): built once per router beside its QueryClient. */
export const makeTrpcProxy = (queryClient: QueryClient, client: TrpcClient = browserTrpcClient()) =>
  createTRPCOptionsProxy<AppRouter>({ client, queryClient });
export type TrpcProxy = ReturnType<typeof makeTrpcProxy>;

export const loginWalkUrl = (): string =>
  withContinuation(
    "/login",
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );

/** The page's one walk to sign-in (`makeLoginWalk`): refused requests and the access event. */
export const loginWalk = makeLoginWalk({
  pathname: () => window.location.pathname,
  loginUrl: loginWalkUrl,
  assign: (url) => window.location.assign(url),
  later: (run, ms) => void window.setTimeout(run, ms),
});

/**
 * Map a mutation's 401 (surfaced as UNAUTHORIZED) to the login walk. These
 * wrappers run from event handlers and menus — no loader is watching, so a
 * thrown TanStack `redirect()` would be inert; navigate directly and rethrow
 * so the caller's own error handling still sees the failure. Query-side 401s
 * are handled once at the QueryCache (router.tsx).
 */
export const orLogin = async <A>(promise: Promise<A>): Promise<A> => {
  try {
    return await promise;
  } catch (error) {
    if (
      typeof window !== "undefined" &&
      error instanceof TRPCClientError &&
      error.data?.code === "UNAUTHORIZED"
    ) {
      loginWalk.refused();
    }
    throw error;
  }
};
