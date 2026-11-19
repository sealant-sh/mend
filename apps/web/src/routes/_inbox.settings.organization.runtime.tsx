import { createFileRoute } from "@tanstack/react-router";

import { RuntimePage } from "#/components/settings/runtime-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → the organization → Runtime: where the organization's new sessions run. Everyone reads
 * it; owners switch it. The old app's `/settings/organization/defaults`, where the runtime lived,
 * lands here through `lib/settings-pages.ts`'s old addresses.
 */
export const Route = createFileRoute("/_inbox/settings/organization/runtime")({
  beforeLoad: guardSettingsPage("o-runtime"),
  // The roster names the owners for everyone else.
  loader: ({ context: { queryClient, trpc } }) =>
    Promise.all([
      queryClient.ensureQueryData(trpc.organization.settings.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
    ]),
  component: RuntimePage,
});
