import { createFileRoute } from "@tanstack/react-router";

import { AppearancePage } from "#/components/settings/appearance-page";
import { guardSettingsPage } from "#/lib/settings-guards";

/** Settings → This device → Appearance: theme, text size and terminal font for this browser. */
export const Route = createFileRoute("/_inbox/settings/appearance")({
  beforeLoad: guardSettingsPage("d-appearance"),
  component: AppearancePage,
});
