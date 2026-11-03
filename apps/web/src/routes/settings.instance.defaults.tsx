import { createFileRoute } from "@tanstack/react-router";

import { InstanceDefaults } from "#/components/settings/instance-defaults";
import { requireOperator } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/instance/defaults")({
  beforeLoad: ({ context }) => requireOperator(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.settings.get.queryOptions()),
  component: InstanceDefaults,
});
