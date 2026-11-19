import { createFileRoute } from "@tanstack/react-router";

import { ConnectedAppsPage } from "#/components/settings/connected-apps-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/** Settings → Account → Connected apps: your own Slack and Executor links, and your Doppler token. */
export const Route = createFileRoute("/_inbox/settings/connected-apps")({
  beforeLoad: guardSettingsPage("a-apps"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.slack.me.queryOptions()),
      queryClient.ensureQueryData(trpc.executor.personal.queryOptions()),
      queryClient.ensureQueryData(trpc.doppler.status.queryOptions()),
    ]),
  component: ConnectedAppsPage,
});
