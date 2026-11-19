import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { NotFoundScreen } from "#/components/route-screens";
import { laterSettingsTarget, settingsViewerFor } from "#/lib/settings-guards";
import { oldWorkspacePath } from "#/lib/settings-pages";

/** The old Workspace page, whose sections now live on three pages: the anchor says which. */
const OLD_WORKSPACE = "/settings/workspace";

/**
 * Any address under Settings that no page's route owns yet. An old address (`/settings/account`,
 * `/settings/git-access`, …) goes to its new home, built or not; a page this person may not open
 * (an owner's page, the Server) goes to Profile, refused by address as it is left out of the
 * sidebar. Anything else is a page whose route PR hasn't landed, or no page at all: not found,
 * inside Settings.
 *
 * `/settings/workspace#<section>` goes to the page that holds that section now. The anchor never
 * reaches the server, so a page loaded from that address is sent on from the browser.
 */
export const Route = createFileRoute("/_inbox/settings/$")({
  beforeLoad: async ({ context, location }) => {
    if (location.pathname.replace(/\/+$/, "") === OLD_WORKSPACE) {
      if (typeof window === "undefined") return;
      throw redirect({ href: oldWorkspacePath(location.hash), replace: true });
    }
    const target = laterSettingsTarget(location.pathname, await settingsViewerFor(context));
    if (target !== null) throw redirect({ href: target, replace: true });
  },
  component: LaterSettings,
});

function LaterSettings() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname.replace(/\/+$/, "") === OLD_WORKSPACE ? <OldWorkspace /> : <NotFoundScreen />;
}

/** The server drew `/settings/workspace` without its anchor: the browser reads it and moves on. */
function OldWorkspace() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ href: oldWorkspacePath(window.location.hash), replace: true });
  }, [navigate]);
  return null;
}
