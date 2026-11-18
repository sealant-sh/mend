import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ResourcesTab } from "#/components/project/resources-tab";
import { useTRPC } from "#/lib/trpc";

/** A project's Resources tab; the project layout has already read the project. */
export const Route = createFileRoute("/_inbox/projects/$projectId/resources")({
  component: ProjectResources,
});

function ProjectResources() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return <ResourcesTab key={projectId} detail={detail} />;
}
