import { createFileRoute } from "@tanstack/react-router";

/** `/skills` with no skill open: the list alone (`_inbox.skills.tsx`). */
export const Route = createFileRoute("/_inbox/skills/")({
  component: () => null,
});
