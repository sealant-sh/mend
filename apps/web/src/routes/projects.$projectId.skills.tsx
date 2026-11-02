import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { SkillsTab } from "#/components/project/tabs/skills-tab";
import { useTRPC } from "#/lib/trpc";

/** The Skills tab (screens K6 and K7): your library here, and the project's own skills. */
export const Route = createFileRoute("/projects/$projectId/skills")({
  ssr: false,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    // Both start at once; the layout already started the project's own.
    void queryClient.prefetchQuery(trpc.skills.list.queryOptions());
    void queryClient.prefetchQuery(trpc.skills.forProject.queryOptions({ id: params.projectId }));
  },
  component: ProjectSkillsPage,
});

function ProjectSkillsPage() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const { project } = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  return <SkillsTab project={project} />;
}
