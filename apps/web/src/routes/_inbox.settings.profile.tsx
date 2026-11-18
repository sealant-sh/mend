import { createFileRoute } from "@tanstack/react-router";

import { ProfilePage } from "#/components/settings/profile-page";
import { accountOptions } from "#/lib/account";
import { guardSettingsPage } from "#/lib/settings-guards";

/** Settings → Account → Profile: the account's name, email and password, and signing out. */
export const Route = createFileRoute("/_inbox/settings/profile")({
  beforeLoad: guardSettingsPage("a-profile"),
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(accountOptions()),
  component: ProfilePage,
});
