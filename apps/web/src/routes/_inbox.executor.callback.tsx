import { Alert, AlertTitle } from "@mend/ui/components/ui/alert";
import { buttonVariants } from "@mend/ui/components/ui/button";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CircleX } from "lucide-react";

import { failureWords } from "#/lib/refusal";

/**
 * Where Executor sends the browser back after someone links an Executor account
 * (`packages/sessions/src/executor/executor.ts` and `mend-run.ts` name this address, so it stays).
 * Mend's server finishes the link with the code and state Executor returned. A person's own link
 * comes back to Connected apps; the organization's member link, which an owner makes, to
 * Integrations; and Executor may name a page of its own to go on to. If the link didn't finish,
 * the page says why and links back.
 */
export const Route = createFileRoute("/_inbox/executor/callback")({
  // Read from the address itself, not as search params: taking the code out of the address must
  // not count as a new address, or the router would run this again with nothing to finish.
  ssr: false,
  preload: false,
  loader: async ({ context: { queryClient, trpc, trpcClient } }) => {
    const search = new URLSearchParams(window.location.search);
    const code = search.get("code") ?? "";
    const state = search.get("state") ?? "";
    const refused = search.get("error") ?? "";
    // The code and state leave the browser's history whatever happens next.
    window.history.replaceState(null, "", window.location.pathname);
    if (refused !== "" || code === "" || state === "") {
      return { message: "Executor didn't finish the link. Start linking again." };
    }
    let finished: { readonly url: string | null; readonly target: "person" | "member" };
    try {
      finished = await trpcClient.executor.finish.mutate({ state, code });
    } catch (error) {
      return { message: failureWords(error, "Mend couldn't finish this link. Start it again.") };
    }
    await queryClient.invalidateQueries(trpc.executor.pathFilter());
    if (finished.url !== null) throw redirect({ href: finished.url, replace: true });
    throw redirect({
      href:
        finished.target === "member"
          ? "/settings/organization/integrations"
          : "/settings/connected-apps",
      replace: true,
    });
  },
  component: LinkRefused,
});

function LinkRefused() {
  const { message } = Route.useLoaderData();
  return (
    <div className="mx-auto w-full max-w-140 px-5 pt-10 pb-10 md:pt-16">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        The Executor link didn't finish
      </h1>
      <Alert tone="error" className="mt-6">
        <CircleX aria-hidden />
        <AlertTitle>{message}</AlertTitle>
      </Alert>
      <div className="mt-8 flex justify-end">
        <Link
          to="/settings/connected-apps"
          className={buttonVariants({ variant: "default", className: "max-md:h-11" })}
        >
          Back to Connected apps
        </Link>
      </div>
    </div>
  );
}
