import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { Page, PageHeader } from "#/components/kit/page";
import { AppShell } from "#/components/shell";

export const Route = createFileRoute("/executor/service-callback")({
  ssr: false,
  preload: false,
  loader: async ({ context }) => {
    try {
      await context.trpcClient.executor.finishService.mutate({
        callbackUrl: window.location.href,
      });
    } catch (error) {
      return {
        message:
          error instanceof Error
            ? error.message
            : "Mend could not complete this service sign-in. Start connecting again.",
      };
    } finally {
      // Remove OAuth code/state from browser history after submitting the bounded return URL.
      window.history.replaceState(null, "", window.location.pathname);
    }
    await context.queryClient.invalidateQueries(context.trpc.executor.pathFilter());
    throw redirect({
      to: "/settings/mcp-servers",
      hash: "executor",
      replace: true,
    });
  },
  component: () => {
    const data = Route.useLoaderData();
    return (
      <AppShell layout="bare">
        <Page head={<PageHeader title="Service sign-in" description={data.message} />}>
          <Link to="/settings/mcp-servers" hash="executor">
            Return to Settings
          </Link>
        </Page>
      </AppShell>
    );
  },
});
