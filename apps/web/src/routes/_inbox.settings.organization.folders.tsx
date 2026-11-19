import { createFileRoute } from "@tanstack/react-router";

import { FoldersPage } from "#/components/settings/folders-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Folders and references: the organization's folders and reference
 * repositories. Everyone reads them; owners change them.
 */
export const Route = createFileRoute("/_inbox/settings/organization/folders")({
  beforeLoad: guardSettingsPage("o-folders"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.folders.list.queryOptions()),
      queryClient.ensureQueryData(trpc.git.references.queryOptions()),
    ]),
  component: FoldersPage,
});
