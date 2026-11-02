import { createFileRoute } from "@tanstack/react-router";

import { LandingSettings } from "#/components/settings/landing";
import { warmPersonAutomation } from "#/components/settings/sessions-defaults";

export const Route = createFileRoute("/settings/landing")({
  loader: ({ context }) => warmPersonAutomation(context),
  component: LandingSettings,
});
