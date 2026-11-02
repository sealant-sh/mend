import { createFileRoute } from "@tanstack/react-router";

import { SessionsSettings } from "#/components/settings/sessions";
import { warmPersonAutomation } from "#/components/settings/sessions-defaults";

export const Route = createFileRoute("/settings/sessions")({
  loader: async ({ context }) => {
    await Promise.all([
      warmPersonAutomation(context),
      context.queryClient.ensureQueryData(context.trpc.platform.messageSettings.queryOptions()),
      // The model list is a nicety for the picker; the tab draws without it.
      context.queryClient.prefetchQuery(
        context.trpc.harnesses.models.queryOptions(undefined, { staleTime: 60_000, retry: false }),
      ),
    ]);
  },
  component: SessionsSettings,
});
