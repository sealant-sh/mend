import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectResources, projectResourcesOptions } from "#/components/project/tabs/resources";
import { useTRPC } from "#/lib/trpc";

/**
 * The Resources tab (screens K4 and K5). The project's read and every worktree's start together:
 * the worktrees come from the project detail the layout already holds.
 */
export const Route = createFileRoute("/projects/$projectId/resources")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const detail = await queryClient.ensureQueryData(
      trpc.projects.detail.queryOptions({ id: params.projectId }),
    );
    void queryClient.prefetchQuery(projectResourcesOptions(trpc, params.projectId, null));
    for (const worktree of detail.worktrees)
      void queryClient.prefetchQuery(projectResourcesOptions(trpc, params.projectId, worktree.id));
  },
  component: ProjectResourcesPage,
});

function ProjectResourcesPage() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return <ProjectResources detail={detail} />;
}
