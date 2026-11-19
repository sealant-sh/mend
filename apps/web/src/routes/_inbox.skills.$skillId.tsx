import { createFileRoute } from "@tanstack/react-router";

import { SkillEditorPage } from "#/components/skills/skill-editor";
import { SkillPanel } from "#/components/skills/skill-panel";
import { YOU } from "#/lib/project-skills";
import { skillSearch } from "#/lib/skills";

/**
 * A skill of the person's own: read beside the list, or edited in its place with `?edit=1`.
 * `?file=<path>` opens one of its files.
 */
export const Route = createFileRoute("/_inbox/skills/$skillId")({
  validateSearch: skillSearch,
  loader: async ({ context: { queryClient, trpc }, params }) => {
    const read = queryClient.prefetchQuery(
      trpc.skills.detail.queryOptions({ skillId: params.skillId }),
    );
    if (typeof window === "undefined") await read;
  },
  component: SkillRoute,
});

function SkillRoute() {
  const { skillId } = Route.useParams();
  const { edit, file } = Route.useSearch();
  return edit === 1 ? (
    <SkillEditorPage skillId={skillId} file={file} owner={YOU} />
  ) : (
    <SkillPanel skillId={skillId} file={file} owner={YOU} />
  );
}
