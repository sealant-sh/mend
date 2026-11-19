import { createFileRoute, redirect } from "@tanstack/react-router";

import { NotFoundScreen } from "#/components/route-screens";
import { oldProjectSettingsPath } from "#/lib/settings-pages";

/**
 * Any address under a project's settings that no page's route owns yet. An old section with no
 * page of its own now (`…/settings/git`, `…/landing`, `…/review`) goes to where that setting lives
 * now; anything else is a page whose route PR hasn't landed, or no page at all: not found, inside
 * Settings.
 */
export const Route = createFileRoute("/_inbox/projects/$projectId_/settings/$")({
  beforeLoad: ({ location }) => {
    const target = oldProjectSettingsPath(location.pathname);
    if (target !== null) throw redirect({ href: target, replace: true });
  },
  component: NotFoundScreen,
});
