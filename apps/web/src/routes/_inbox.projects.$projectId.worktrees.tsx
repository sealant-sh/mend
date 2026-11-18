import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { WorktreesTab } from "#/components/project/worktrees-tab";
import { useTRPC } from "#/lib/trpc";

/** A project's Worktrees tab; the project layout has already read the project. */
export const Route = createFileRoute("/_inbox/projects/$projectId/worktrees")({
  component: ProjectWorktrees,
});

function ProjectWorktrees() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return <WorktreesTab detail={detail} />;
}
