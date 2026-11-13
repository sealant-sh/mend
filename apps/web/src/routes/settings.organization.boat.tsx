import { createFileRoute } from "@tanstack/react-router";

import { BoatKeyTab } from "#/components/settings/boat-key";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/boat")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: async ({ context }) => {
    const { queryClient, trpc } = context;
    await queryClient.ensureQueryData(trpc.boatKey.status.queryOptions());
  },
  component: BoatKeyTab,
});
