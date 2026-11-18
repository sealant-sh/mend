import { createFileRoute } from "@tanstack/react-router";

import { ProfilePage } from "#/components/settings/profile-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/** Settings → Account → Profile: the account's name, email and password, and signing out. */
export const Route = createFileRoute("/_inbox/settings/profile")({
  beforeLoad: guardSettingsPage("a-profile"),
  // The roster names the account; the layout's loader already asked for it.
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
  component: ProfilePage,
});
