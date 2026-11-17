import { createFileRoute } from "@tanstack/react-router";

import { InvitationsTab } from "#/components/settings/org-invitations";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/invitations")({
  beforeLoad: ({ context }) => requireOrganization(context, "owner"),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.organization.invitations.queryOptions()),
  component: InvitationsTab,
});
