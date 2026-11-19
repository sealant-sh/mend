import { createFileRoute } from "@tanstack/react-router";

import { OrganizationMembersPage } from "#/components/settings/organization-members-page";
import { guardSettingsPage } from "#/lib/settings-guards";
import { signedInOptions } from "#/lib/sign-in";

/**
 * Settings → the organization → Members: the roster for everyone; invitations, roles, password
 * reset links and removals for its owners. The old app's `/settings/organization/invitations`
 * lands here through `lib/settings-pages.ts`'s old addresses.
 */
export const Route = createFileRoute("/_inbox/settings/organization/members")({
  beforeLoad: guardSettingsPage("o-members"),
  loader: async ({ context: { queryClient, trpc } }) => {
    const viewer = await queryClient.ensureQueryData(signedInOptions(trpc));
    await Promise.all([
      queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
      // Owners only: the server answers anyone else 404.
      viewer.role === "owner"
        ? queryClient.ensureQueryData(trpc.organization.invitations.queryOptions())
        : null,
    ]);
  },
  component: OrganizationMembersPage,
});
