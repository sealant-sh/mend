import { createFileRoute } from "@tanstack/react-router";

import { ReviewSettings } from "#/components/settings/review";
import { warmInheritedDefaults } from "#/components/settings/sessions-defaults";

export const Route = createFileRoute("/settings/review")({
  loader: ({ context }) => warmInheritedDefaults(context),
  component: ReviewSettings,
});
