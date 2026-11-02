import { createFileRoute } from "@tanstack/react-router";

import { GitAccessSettings, gitAccessOptions } from "#/components/settings/git-access";

export const Route = createFileRoute("/settings/git-access")({
  loader: async ({ context: { queryClient, trpc } }) => {
    await Promise.all([
      queryClient.ensureQueryData(gitAccessOptions(trpc)),
      queryClient.ensureQueryData(trpc.git.author.queryOptions()),
    ]);
  },
  component: GitAccessSettings,
});
