import { createFileRoute } from "@tanstack/react-router";

import { SkillEditorPage } from "#/components/skills/skill-editor";
import { SkillPanel } from "#/components/skills/skill-panel";
import { editing } from "#/lib/project-skills";
import { skillSearch } from "#/lib/skill-search";
import { useProjectSkillOwner } from "#/lib/use-project-skill-owner";

/**
 * A project's skill: read beside the project's list, or, for someone who may change it, edited in
 * place of the whole project page with `?edit=1`. `?file=<path>` opens one of its files. Anyone
 * else who opens `?edit=1` reads it.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId/skills/$skillId")({
  validateSearch: skillSearch,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const read = queryClient.prefetchQuery(
      trpc.skills.detail.queryOptions({ skillId: params.skillId }),
    );
    if (typeof window === "undefined") await read;
  },
  component: ProjectSkillRoute,
});

function ProjectSkillRoute() {
  const { projectId, skillId } = Route.useParams();
  const search = Route.useSearch();
  const owner = useProjectSkillOwner(projectId);
  return editing(owner, search) ? (
    <SkillEditorPage skillId={skillId} file={search.file} owner={owner} />
  ) : (
    <SkillPanel skillId={skillId} file={search.file} owner={owner} />
  );
}
