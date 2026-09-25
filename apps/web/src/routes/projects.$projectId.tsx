import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ProjectShell } from "#/components/project-shell";
import { useTRPC } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

/**
 * The project layout: one ProjectShell (header, tabs, app sidebar) around the Worktrees and Setup
 * tabs. The tabs are child routes, so switching between them swaps only the <Outlet> — the frame
 * and its event subscription stay mounted instead of being torn down and rebuilt.
 */
export const Route = createFileRoute("/projects/$projectId")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    await queryClient.ensureQueryData(trpc.projects.detail.queryOptions({ id: params.projectId }));
  },
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const { project } = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  useWorkbenchEvents();

  return (
    <ProjectShell project={project}>
      <Outlet />
    </ProjectShell>
  );
}
