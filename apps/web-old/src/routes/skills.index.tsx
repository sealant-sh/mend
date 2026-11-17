import { createFileRoute } from "@tanstack/react-router";

import { SkillLibraryPage } from "#/components/skills/skill-library";

export const Route = createFileRoute("/skills/")({
  ssr: false,
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.skills.list.queryOptions()),
  component: SkillLibraryPage,
});
