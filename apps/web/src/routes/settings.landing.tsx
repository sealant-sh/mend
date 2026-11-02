import { createFileRoute } from "@tanstack/react-router";

import { LandingSettings } from "#/components/settings/landing";
import { warmInheritedDefaults } from "#/components/settings/sessions-defaults";

export const Route = createFileRoute("/settings/landing")({
  loader: ({ context }) => warmInheritedDefaults(context),
  component: LandingSettings,
});
