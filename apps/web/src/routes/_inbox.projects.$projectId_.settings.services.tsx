import { createFileRoute } from "@tanstack/react-router";

import { ProjectServicesPage } from "#/components/settings/project-services-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → a project → Services: the default branch's `.mend/mend.toml`, read-only, and the
 * fixed preview address with the worktree it shows.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/services")({
  beforeLoad: guardSettingsPage("p-services"),
  loader: ({ context: { queryClient, trpc }, params }) => {
    void queryClient.prefetchQuery(trpc.previews.project.queryOptions({ id: params.projectId }));
    return queryClient.ensureQueryData(
      trpc.projects.mendToml.queryOptions({ id: params.projectId }),
    );
  },
  component: ServicesRoute,
});

function ServicesRoute() {
  const { projectId } = Route.useParams();
  return <ProjectServicesPage projectId={projectId} />;
}
