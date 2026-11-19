import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { PhoneSettings } from "#/components/settings/phone-settings";
import { ProfilePage } from "#/components/settings/profile-page";
import { oldAnchorPath } from "#/lib/settings-pages";

/**
 * `/settings`: on the desk it opens Profile, the first page; under 1024px it is the phone's
 * Settings tab, which lists every page. An anchor from the old single settings page
 * (`/settings#devices`, in Slack messages and older links) opens the page that holds that setting
 * now.
 */
export const Route = createFileRoute("/_inbox/settings/")({
  // The roster names the account; the layout's loader already asked for it.
  loader: ({ context: { queryClient, trpc } }) =>
    queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
  component: SettingsHome,
});

function SettingsHome() {
  const navigate = useNavigate();
  // The fragment never reaches the server, so the browser reads it once the page is up.
  useEffect(() => {
    const target = oldAnchorPath(window.location.hash);
    if (target !== null) void navigate({ href: target, replace: true });
  }, [navigate]);
  return (
    <>
      <div className="contents lg:hidden">
        <PhoneSettings />
      </div>
      <div className="contents max-lg:hidden">
        <ProfilePage />
      </div>
    </>
  );
}
