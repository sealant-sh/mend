import { createFileRoute } from "@tanstack/react-router";

import { OrganizationEnvironmentTab } from "#/components/settings/environment-organization";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/environment")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.organization.settings.queryOptions()),
  component: OrganizationEnvironmentTab,
});
