import { createFileRoute } from "@tanstack/react-router";

import { FoldersTab } from "#/components/settings/org-folders";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/folders")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.folders.list.queryOptions()),
  component: FoldersTab,
});
