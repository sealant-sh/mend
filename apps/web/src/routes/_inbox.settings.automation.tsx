import { createFileRoute } from "@tanstack/react-router";

import { AutomationPage } from "#/components/settings/automation-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → Account → Your automation: what Mend does in your sessions without being asked.
 * Old `/settings/review`, `/settings/landing` and `/settings/sessions` come here (`OLD_PATHS`).
 */
export const Route = createFileRoute("/_inbox/settings/automation")({
  beforeLoad: guardSettingsPage("a-automation"),
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.platform.automation.queryOptions()),
      queryClient.ensureQueryData(trpc.platform.settleSettings.queryOptions()),
    ]),
  component: AutomationPage,
});
