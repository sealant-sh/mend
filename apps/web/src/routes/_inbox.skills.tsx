import { createFileRoute } from "@tanstack/react-router";

import { SkillsPage } from "#/components/skills/skills-page";

/**
 * Skills: the person's own skills (`/skills`), with the open one beside the list
 * (`/skills/<id>`). A project's skills are on the project's Skills tab, a later route.
 */
export const Route = createFileRoute("/_inbox/skills")({
  // The list is read here and drawn by the page with its loading and failed states. On the server
  // the page waits for it, so it arrives drawn; in the browser nothing holds the navigation back.
  loader: async ({ context: { queryClient, trpc } }) => {
    const read = queryClient.prefetchQuery(trpc.skills.list.queryOptions());
    if (typeof window === "undefined") await read;
  },
  component: SkillsPage,
});
