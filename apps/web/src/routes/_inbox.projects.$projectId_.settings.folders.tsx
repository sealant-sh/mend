import { createFileRoute } from "@tanstack/react-router";

import { ProjectFoldersPage } from "#/components/settings/project-folders-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/**
 * Settings → a project → Folders and references: which of the organization's folders and
 * references the project's sessions get, and its server folders. The old app's
 * `/projects/<id>/configuration#folders`, `#references` and `#mounts` land here through
 * `lib/settings-pages.ts`.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/folders")({
  beforeLoad: guardSettingsPage("p-folders"),
  loader: async ({ context: { queryClient, trpc }, params: { projectId } }) => {
    await Promise.all([
      queryClient.ensureQueryData(trpc.folders.list.queryOptions()),
      queryClient.ensureQueryData(trpc.projects.folders.queryOptions({ id: projectId })),
      queryClient.ensureQueryData(trpc.git.references.queryOptions()),
      queryClient.ensureQueryData(trpc.projects.references.queryOptions({ id: projectId })),
      queryClient.ensureQueryData(trpc.projects.mounts.queryOptions({ id: projectId })),
    ]);
  },
  component: FoldersRoute,
});

function FoldersRoute() {
  const { projectId } = Route.useParams();
  return <ProjectFoldersPage projectId={projectId} />;
}
