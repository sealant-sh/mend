import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceImagePage } from "#/components/settings/workspace-image-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Workspace image: the starting image Mend copies into each new
 * project. Everyone reads it; owners change it. The old app's `/settings/organization/environment`
 * lands here through `lib/settings-pages.ts`'s old addresses.
 */
export const Route = createFileRoute("/_inbox/settings/organization/workspace-image")({
  beforeLoad: guardSettingsPage("o-image"),
  // The roster names the owners for everyone else.
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.organization.settings.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
    ]),
  component: WorkspaceImagePage,
});
