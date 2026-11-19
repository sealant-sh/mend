import { createFileRoute } from "@tanstack/react-router";

import { OrganizationGeneralPage } from "#/components/settings/organization-general-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → General: its name, who owns it, and leaving it. The old app's
 * `/settings/organization/` (which opened Members) lands here, and so does
 * `/settings/organization/defaults`, through `lib/settings-pages.ts`'s old addresses.
 */
export const Route = createFileRoute("/_inbox/settings/organization/")({
  beforeLoad: guardSettingsPage("o-general"),
  // The roster names the owners; the person's organizations say whether they may leave.
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
      queryClient.ensureQueryData(trpc.organizations.list.queryOptions()),
    ]),
  component: OrganizationGeneralPage,
});
