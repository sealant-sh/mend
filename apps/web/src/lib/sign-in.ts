import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { TRPCClientError } from "@trpc/client";

import type { RouterAppContext } from "../router.tsx";
import type { TrpcProxy } from "./trpc.ts";

/**
 * Where a page with no signed-in person walks: `/login`, carrying the page to come back to in its
 * fragment (`#next=…`) when there is one, the form the old app's sign-in page reads.
 *
 * The new app has no sign-in page yet: until its route lands, `/login` here shows the not-found
 * screen, and a person signs in through the old app, whose session cookie this app shares.
 */
export const SIGN_IN_PATH = "/login";

export const signInPath = (next: string): string =>
  next === "/" ? SIGN_IN_PATH : `${SIGN_IN_PATH}#${new URLSearchParams({ next }).toString()}`;

/**
 * The first path segments of the pages a signed-out person may open: sign-in itself, or the walk
 * would loop. A route PR for another such page (an invitation, a password reset) adds its segment.
 */
const SIGNED_OUT_PAGES: ReadonlySet<string> = new Set([SIGN_IN_PATH.slice(1)]);

export const opensSignedOut = (pathname: string): boolean =>
  SIGNED_OUT_PAGES.has(pathname.split("/")[1] ?? "");

/**
 * The read of who is signed in, one set of options for hooks and loaders alike, so a loader that
 * warmed it and a page that reads it share one cache entry and one stale time.
 */
export const signedInOptions = (trpc: TrpcProxy) =>
  trpc.organization.current.queryOptions(undefined, {
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: "always",
  });

const refused = (error: unknown): boolean =>
  error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED";

/**
 * Every page but the signed-out ones needs a signed-in person (the root route's `beforeLoad`).
 * A page served to nobody redirects to sign-in before it renders, as the old app's do. In the
 * browser a refused read has already started the query cache's walk to sign-in (router.tsx), so
 * this only stops the page. Any other failure is the page's error.
 */
export const requireSignedIn = async ({
  context,
  location,
}: {
  readonly context: Pick<RouterAppContext, "queryClient" | "trpc">;
  readonly location: Pick<ParsedLocation, "pathname" | "href">;
}): Promise<void> => {
  if (opensSignedOut(location.pathname)) return;
  try {
    // Fresh within its stale time, read again after it: a page opened later asks again.
    await context.queryClient.fetchQuery(signedInOptions(context.trpc));
  } catch (error) {
    if (!refused(error)) throw error;
    if (typeof window !== "undefined") return;
    throw redirect({ href: signInPath(location.href) });
  }
};
