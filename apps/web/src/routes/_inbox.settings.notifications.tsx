import { createFileRoute } from "@tanstack/react-router";

import { NotificationsPage } from "#/components/settings/notifications-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/** Settings → Account → Notifications: what the Mend app on your phones tells you about. */
export const Route = createFileRoute("/_inbox/settings/notifications")({
  beforeLoad: guardSettingsPage("a-notifications"),
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.devices.notificationSettings.queryOptions()),
  component: NotificationsPage,
});
