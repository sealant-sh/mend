import { createFileRoute } from "@tanstack/react-router";

import { SkillsTab } from "#/components/project/skills-tab";

/**
 * A project's Skills tab: the project's own skills (`/projects/<id>/skills`), with the open one
 * beside the list (`/projects/<id>/skills/<skillId>`). The project layout has already read the
 * project and started reading its skills.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId/skills")({
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const read = queryClient.prefetchQuery(
      trpc.skills.forProject.queryOptions({ id: params.projectId }),
    );
    if (typeof window === "undefined") await read;
  },
  component: ProjectSkills,
});

function ProjectSkills() {
  const { projectId } = Route.useParams();
  return <SkillsTab key={projectId} projectId={projectId} />;
}
