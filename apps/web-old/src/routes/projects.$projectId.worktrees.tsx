import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { WorktreesTab } from "#/components/project/tabs/worktrees";
import { useTRPC } from "#/lib/trpc";

/** The Worktrees tab (screen K2); the project layout has already read the project. */
export const Route = createFileRoute("/projects/$projectId/worktrees")({
  component: ProjectWorktreesPage,
});

function ProjectWorktreesPage() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return <WorktreesTab detail={detail} />;
}
