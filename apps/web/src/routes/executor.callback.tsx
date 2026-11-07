import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { Page, PageHeader } from "#/components/kit/page";
import { AppShell } from "#/components/shell";
export const Route = createFileRoute("/executor/callback")({
  ssr: false,
  validateSearch: (value: Record<string, unknown>) => ({
    state: typeof value.state === "string" ? value.state : "",
    code: typeof value.code === "string" ? value.code : "",
    error: typeof value.error === "string" ? value.error : "",
  }),
  loaderDeps: ({ search }) => search,
  preload: false,
  loader: async ({ context, deps }) => {
    if (deps.error !== "" || !deps.code || !deps.state)
      return { message: "Executor consent was not completed. Start linking again from Settings." };
    let result;
    try {
      result = await context.trpcClient.executor.finish.mutate({
        state: deps.state,
        code: deps.code,
      });
    } catch (error) {
      return {
        message:
          error instanceof Error
            ? error.message
            : "Mend could not finish this Executor link. Start linking again.",
      };
    }
    await context.queryClient.invalidateQueries(context.trpc.executor.pathFilter());
    if (result.url !== null) throw redirect({ href: result.url, replace: true });
    throw redirect({
      to: result.target === "member" ? "/settings/organization/executor" : "/settings/workspace",
      replace: true,
    });
  },
  component: () => {
    const data = Route.useLoaderData();
    return (
      <AppShell layout="bare">
        <Page head={<PageHeader title="Executor link" description={data.message} />}>
          <Link to="/settings/workspace">Return to Settings</Link>
        </Page>
      </AppShell>
    );
  },
});
