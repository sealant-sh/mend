import type { RouterAppContext } from "#/router";

/**
 * What the composer can't draw without: the projects to start in and the agent, model and effort
 * the person last used. The page waits for them (a failure is the route's error screen, with Try
 * again); the rest it reads beside them and draws as each arrives.
 */
export const newSessionLoader = async ({
  context: { queryClient, trpc },
}: {
  readonly context: Pick<RouterAppContext, "queryClient" | "trpc">;
}): Promise<void> => {
  void queryClient.prefetchQuery(
    trpc.harnesses.models.queryOptions(undefined, { staleTime: 60_000, retry: false }),
  );
  void queryClient.prefetchQuery(
    trpc.platform.sealantIdentity.queryOptions(undefined, { staleTime: 30_000, retry: false }),
  );
  void queryClient.prefetchQuery(trpc.platform.automation.queryOptions());
  await Promise.all([
    queryClient.ensureQueryData(trpc.projects.list.queryOptions()),
    queryClient.ensureQueryData(trpc.platform.sessionDefaults.queryOptions()),
  ]);
};
