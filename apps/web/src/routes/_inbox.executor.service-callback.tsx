import { Alert, AlertTitle } from "@mend/ui/components/ui/alert";
import { buttonVariants } from "@mend/ui/components/ui/button";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CircleX } from "lucide-react";

import { failureWords } from "#/lib/refusal";

/**
 * Where Executor sends the browser back after a person signs in to a service from Settings → MCP
 * servers, or an owner signs the organization's shared account in to one from Integrations (`packages/sessions/src/executor/mend-run.ts` names this address, so it stays). The
 * whole return address goes to Mend's server, which finishes the sign-in with Executor; the code
 * and state then leave the browser's history, and the person is back where they started. If Executor
 * refuses, the page says why and links back.
 */
export const Route = createFileRoute("/_inbox/executor/service-callback")({
  ssr: false,
  preload: false,
  loader: async ({ context: { queryClient, trpc, trpcClient } }) => {
    let target: "person" | "member";
    try {
      ({ target } = await trpcClient.executor.finishService.mutate({
        callbackUrl: window.location.href,
      }));
    } catch (error) {
      return {
        message: failureWords(error, "Mend couldn't finish this sign-in. Start it again."),
      };
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
    await queryClient.invalidateQueries(trpc.executor.pathFilter());
    // A sign-in for the organization's shared account came from Integrations; a person's own,
    // from MCP servers.
    throw redirect({
      to: target === "member" ? "/settings/organization/integrations" : "/settings/mcp-servers",
      replace: true,
    });
  },
  component: SignInRefused,
});

function SignInRefused() {
  const { message } = Route.useLoaderData();
  return (
    <div className="mx-auto w-full max-w-140 px-5 pt-10 pb-10 md:pt-16">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        The sign-in didn't finish
      </h1>
      <Alert tone="error" className="mt-6">
        <CircleX aria-hidden />
        <AlertTitle>{message}</AlertTitle>
      </Alert>
      <div className="mt-8 flex justify-end">
        <Link
          to="/settings/mcp-servers"
          className={buttonVariants({ variant: "default", className: "max-md:h-11" })}
        >
          Back to MCP servers
        </Link>
      </div>
    </div>
  );
}
