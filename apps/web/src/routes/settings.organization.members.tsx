import { createFileRoute } from "@tanstack/react-router";

import { MembersTab } from "#/components/settings/org-members";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/members")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
  component: MembersTab,
});
