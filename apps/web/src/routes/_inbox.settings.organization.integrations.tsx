import { createFileRoute } from "@tanstack/react-router";

import { IntegrationsPage } from "#/components/settings/integrations-page";
import { guardSettingsPage } from "#/lib/settings-guards";
import { signedInOptions } from "#/lib/sign-in";

/**
 * Settings → the organization → Integrations: the organization's Slack app and Executor. Old
 * `/settings/organization/slack` (Slack's `@mend settings` links there) and
 * `/settings/organization/executor` land here (`lib/settings-pages.ts`). An owner's page reads the
 * Slack app; a member's, only whether Slack is connected.
 */
export const Route = createFileRoute("/_inbox/settings/organization/integrations")({
  beforeLoad: guardSettingsPage("o-integrations"),
  loader: async ({ context: { queryClient, trpc } }) => {
    const { role } = await queryClient.ensureQueryData(signedInOptions(trpc));
    await Promise.all([
      role === "owner"
        ? queryClient.ensureQueryData(trpc.slack.app.queryOptions())
        : queryClient.ensureQueryData(trpc.slack.me.queryOptions()),
      queryClient.prefetchQuery(trpc.executor.configuration.queryOptions()),
    ]);
  },
  component: IntegrationsPage,
});
