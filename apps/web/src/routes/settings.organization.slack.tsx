import { createFileRoute } from "@tanstack/react-router";

import { SlackTab } from "#/components/settings/slack-tab";
import { requireOrganization } from "#/lib/settings-guards";

export const Route = createFileRoute("/settings/organization/slack")({
  beforeLoad: ({ context }) => requireOrganization(context),
  loader: async ({ context }) => {
    const { queryClient, trpc } = context;
    const view = await requireOrganization(context);
    await Promise.all([
      queryClient.ensureQueryData(trpc.slack.me.queryOptions(undefined, { retry: false })),
      // The app, its tokens and its Slack links are the owners' alone; nobody else asks.
      view.role === "owner"
        ? queryClient.ensureQueryData(trpc.slack.app.queryOptions(undefined, { staleTime: 60_000 }))
        : null,
      queryClient.prefetchQuery(trpc.projects.list.queryOptions()),
    ]);
  },
  component: SlackTab,
});
