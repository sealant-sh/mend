import { createFileRoute } from "@tanstack/react-router";

import { AccessPoliciesPage } from "#/components/settings/access-policies-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Access policies: the organization's policy templates and its
 * durable revocations. Everyone reads them; owners write them and revoke access.
 */
export const Route = createFileRoute("/_inbox/settings/organization/access-policies")({
  beforeLoad: guardSettingsPage("o-access"),
  // The roster names the owners and who revoked what.
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.accessPolicies.list.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
    ]),
  component: AccessPoliciesPage,
});
