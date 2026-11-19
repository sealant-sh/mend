import { createFileRoute } from "@tanstack/react-router";

import { OnlyYouPage } from "#/components/settings/only-you-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → a project → Only you: the signed-in person's own agent memory in the project and the
 * Doppler config it uses for them. Both are read as the person, so the page only ever shows the
 * viewer's own.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/only-you")({
  beforeLoad: guardSettingsPage("p-only-you"),
  loader: async ({ context: { queryClient, trpc }, params: { projectId } }) => {
    await Promise.all([
      queryClient.ensureQueryData(trpc.memory.list.queryOptions({ id: projectId })),
      queryClient.ensureQueryData(trpc.doppler.status.queryOptions()),
    ]);
  },
  component: OnlyYouRoute,
});

function OnlyYouRoute() {
  const { projectId } = Route.useParams();
  return <OnlyYouPage projectId={projectId} />;
}
