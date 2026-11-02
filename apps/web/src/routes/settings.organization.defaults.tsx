import { createFileRoute } from "@tanstack/react-router";

import { DefaultsTab } from "#/components/settings/org-defaults";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/defaults")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.organization.settings.queryOptions()),
  component: DefaultsTab,
});
