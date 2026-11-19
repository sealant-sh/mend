import { createFileRoute } from "@tanstack/react-router";

import { ProjectSecretsPage } from "#/components/settings/project-secrets-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → a project → Variables and secrets: the project's environment variables and its
 * secrets, which every session in it gets.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/secrets")({
  beforeLoad: guardSettingsPage("p-secrets"),
  loader: ({ context: { queryClient, trpc }, params }) => {
    // Cluster bindings show only on some servers, under the rest: read them, don't wait.
    void queryClient.prefetchQuery(
      trpc.environment.clusterBindings.queryOptions({ projectId: params.projectId }),
    );
    return Promise.all([
      queryClient.ensureQueryData(
        trpc.environment.environment.queryOptions({ projectId: params.projectId }),
      ),
      queryClient.ensureQueryData(
        trpc.environment.secrets.queryOptions({ projectId: params.projectId }),
      ),
    ]);
  },
  component: SecretsRoute,
});

function SecretsRoute() {
  const { projectId } = Route.useParams();
  return <ProjectSecretsPage projectId={projectId} />;
}
