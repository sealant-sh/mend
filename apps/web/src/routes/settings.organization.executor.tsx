import { createFileRoute } from "@tanstack/react-router";

import { OrganizationExecutorSettings } from "#/components/settings/executor";
import { requireOrganization } from "#/lib/settings-guards";
export const Route = createFileRoute("/settings/organization/executor")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(context.trpc.executor.configuration.queryOptions()),
  component: OrganizationExecutorSettings,
});
