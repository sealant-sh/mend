import { createFileRoute } from "@tanstack/react-router";

import { InstanceEnvironmentTab } from "#/components/settings/environment-instance";
import { requireOperator } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/instance/environment")({
  beforeLoad: ({ context }) => requireOperator(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.settings.get.queryOptions()),
  component: InstanceEnvironmentTab,
});
