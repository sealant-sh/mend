import { createFileRoute } from "@tanstack/react-router";

import { SkillPage, skillSearch } from "#/components/skills/skill-page";

export const Route = createFileRoute("/skills/$skillId")({
  ssr: false,
  validateSearch: skillSearch,
  loader: ({ context: { queryClient, trpc }, params }) =>
    queryClient.ensureQueryData(trpc.skills.detail.queryOptions({ skillId: params.skillId })),
  component: SkillRoute,
});

function SkillRoute() {
  const { skillId } = Route.useParams();
  const search = Route.useSearch();
  return <SkillPage skillId={skillId} search={search} />;
}
