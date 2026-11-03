import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceSettings } from "#/components/settings/workspace";

export const Route = createFileRoute("/settings/workspace")({
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.settings.dotfiles.queryOptions()),
      queryClient.ensureQueryData(trpc.settings.secretFiles.queryOptions()),
      queryClient.ensureQueryData(trpc.doppler.status.queryOptions()),
      // Read on their own: a platform or Doppler that cannot answer leaves the tab standing.
      queryClient.prefetchQuery(trpc.platform.workspaceSsh.queryOptions()),
      queryClient.prefetchQuery(trpc.projects.list.queryOptions()),
    ]),
  component: WorkspaceSettings,
});
