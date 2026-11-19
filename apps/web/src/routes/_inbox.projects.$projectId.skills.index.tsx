import { createFileRoute } from "@tanstack/react-router";

/** A project's Skills tab with no skill open: the list alone (`_inbox.projects.$projectId.skills.tsx`). */
export const Route = createFileRoute("/_inbox/projects/$projectId/skills/")({
  component: () => null,
});
