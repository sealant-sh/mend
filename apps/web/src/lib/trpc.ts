import type { QueryClient } from "@tanstack/react-query";
import { createServerOnlyFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  splitLink,
  TRPCClientError,
  type TRPCLink,
} from "@trpc/client";
import { createTRPCContext, createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import superjson from "superjson";

import type { AppRouter } from "../server/routers/index.ts";
import { makeLoginWalk } from "./login-walk.ts";
import { withContinuation } from "./onboarding.ts";

/**
 * The UI's one client of the web tier's tRPC surface. Same origin — the web
 * server hosts /trpc and forwards to the API with this browser's cookies.
 * superjson matches the server's transformer, so Dates, bigints and branded
 * ids arrive as themselves.
 */
/**
 * In the browser this is same-origin; during server rendering there is no
 * origin to be relative to, so point at this web server's own port, with the
 * page request's credentials (`forwardedHeaders`).
 */
const trpcUrl =
  typeof window === "undefined"
    ? `http://localhost:${process.env["PORT"] ?? "3105"}/trpc`
    : "/trpc";

/**
 * Calls that go out alone, never in a batch: a batch answers when its slowest call does, so one
 * that execs into a session's workspace (`sessions.recipes` reads the worktree, seconds on a heavy
 * one) would hold back the viewer, the roster and every other quick read beside it.
 */
export const UNBATCHED_PATHS: ReadonlySet<string> = new Set(["sessions.recipes"]);

type TrpcFetch = NonNullable<Parameters<typeof httpLink>[0]["fetch"]>;

/**
 * What a call carries beyond the browser's own: nothing in the browser, where the cookie goes by
 * itself. While a page renders on the server, the page request's cookie (and the client chain it
 * came through), with the app's own Origin, which the web tier's source check requires of a
 * cookie-bearing call. Read per call, so each render speaks for its own request.
 */
const pageRequestHeaders = createServerOnlyFn((): Record<string, string> => {
  const incoming = getRequestHeaders();
  const forwarded: Record<string, string> = {
    origin: new URL(process.env["APP_URL"] ?? "http://localhost:3105").origin,
  };
  for (const name of ["cookie", "authorization", "x-forwarded-for"] as const) {
    const value = incoming.get(name);
    if (value !== null) forwarded[name] = value;
  }
  return forwarded;
});
const forwardedHeaders = (): Record<string, string> => {
  if (typeof window !== "undefined") return {};
  try {
    return pageRequestHeaders();
  } catch {
    // Outside a page render (a script or a test in Node) there is no request to speak for.
    return {};
  }
};

export const trpcLinks = (url: string, fetch?: TrpcFetch): TRPCLink<AppRouter>[] => {
  const options = {
    url,
    transformer: superjson,
    methodOverride: "POST",
    headers: () => forwardedHeaders(),
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

export const trpcClient = createTRPCClient<AppRouter>({ links: trpcLinks(trpcUrl) });

/** Hook-side access (components): `const trpc = useTRPC()` → queryOptions/mutationOptions. */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** Router-context access (loaders): built once per router beside its QueryClient. */
export const makeTrpcProxy = (queryClient: QueryClient) =>
  createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
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
