import { createFileRoute, redirect } from "@tanstack/react-router";

import { NotFoundScreen } from "#/components/route-screens";
import { laterSettingsTarget, settingsViewerFor } from "#/lib/settings-guards";

/**
 * Any address under Settings that no page's route owns yet. An old address (`/settings/account`,
 * `/settings/git-access`, …) goes to its new home, built or not; a page this person may not open
 * (an owner's page, the Server) goes to Profile, refused by address as it is left out of the
 * sidebar. Anything else is a page whose route PR hasn't landed, or no page at all: not found,
 * inside Settings.
 */
export const Route = createFileRoute("/_inbox/settings/$")({
  beforeLoad: async ({ context, location }) => {
    const target = laterSettingsTarget(location.pathname, await settingsViewerFor(context));
    if (target !== null) throw redirect({ href: target, replace: true });
  },
  component: NotFoundScreen,
});
