import { createFileRoute } from "@tanstack/react-router";

import { ReviewSettings } from "#/components/settings/review";
import { warmPersonAutomation } from "#/components/settings/sessions-defaults";

export const Route = createFileRoute("/settings/review")({
  loader: ({ context }) => warmPersonAutomation(context),
  component: ReviewSettings,
});
