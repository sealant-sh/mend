import { createFileRoute } from "@tanstack/react-router";

import { PhoneAccountRow } from "#/components/account-menu";
import { PhoneOrganizationRow } from "#/components/organization-menu";
import { PhoneTabBar } from "#/components/phone-inbox";
import { NotFoundScreen } from "#/components/route-screens";
import { useInbox } from "#/lib/use-inbox";
import { useViewer } from "#/lib/use-viewer";

/**
 * The phone's Settings tab (Doop "Phone · account actions", "Phone · organization switcher"): at
 * its top, the account row (the account's actions) and the organization row (the switcher). The
 * pages under them, and Settings on the desk, come with route PR 37; until then the desk shows
 * not found here, as it does for any address no route owns yet.
 */
export const Route = createFileRoute("/_inbox/settings/")({
  component: SettingsTab,
});

function SettingsTab() {
  const { organizationName, account } = useViewer();
  const inbox = useInbox();
  const waiting = inbox.status === "success" ? inbox.view.groups.waiting.length : 0;
  return (
    <>
      <div className="flex min-h-dvh flex-col bg-background pb-14 lg:hidden">
        <header className="px-4 pt-3 pb-3">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </header>
        <div className="border-t border-border">
          <PhoneAccountRow account={account} />
          <PhoneOrganizationRow organizationName={organizationName} />
        </div>
        <PhoneTabBar active="settings" badge={waiting} />
      </div>
      <div className="contents max-lg:hidden">
        <NotFoundScreen />
      </div>
    </>
  );
}
