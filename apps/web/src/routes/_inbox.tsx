import { SidebarInset, SidebarProvider } from "@mend/ui/components/ui/sidebar";
import { cn } from "@mend/ui/lib/utils";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { AppSidebar, SIDEBAR_RAIL_WIDTH, SIDEBAR_WIDTH } from "#/components/app-sidebar";
import { SearchProvider } from "#/components/command-palette";
import { SwitchedToast } from "#/components/organization-menu";
import { PhoneInbox } from "#/components/phone-inbox";
import { InSheet } from "#/components/route-screens";
import { StopSessionHost } from "#/components/session/stop-session-host";
import { SettingsSidebar } from "#/components/settings/settings-sidebar";
import { Toaster } from "#/components/toaster";
import { inboxQuery } from "#/lib/inbox-live";
import { useOnline } from "#/lib/online";
import { isSettingsPath } from "#/lib/settings-pages";
import { sidebarExpanded } from "#/lib/ui-prefs";
import { inboxMarksQuery, useInbox } from "#/lib/use-inbox";
import { useViewer } from "#/lib/use-viewer";
import { useWorkbenchEvents } from "#/lib/workbench-events";

/**
 * The frame around every signed-in page: the desk, the sidebar on it (the only inbox), and the
 * sheet the page sits on. The sidebar is rendered here once, so moving between pages never
 * remounts it; only the sheet changes.
 *
 * Under 1024px there is no sidebar: home is the inbox as its own screen, with the tab bar, and
 * every other page takes the whole width. The organization switcher and the account menu are at
 * the top of the Settings tab there (`/settings`). The New session composer, home's sheet on a wide
 * screen, is `/new` there.
 *
 * On Settings' own pages (`/settings/…`, a project's `/projects/<id>/settings/…`) the settings
 * sidebar takes the app sidebar's place on the desk, with Back to app at its top.
 */
export const Route = createFileRoute("/_inbox")({
  // The inbox's reads, against the options the inbox reads them with. On the server the page waits
  // for them, so it arrives with the inbox in it. In the browser nothing is awaited: this runs
  // again on every navigation, reads only what isn't cached yet (each read keeps a stale time, and
  // the event stream patches the rows), and never holds a navigation back.
  loader: async ({ context: { queryClient, trpc } }) => {
    const reads = Promise.all([
      queryClient.ensureQueryData(inboxQuery(trpc)),
      queryClient.ensureQueryData(inboxMarksQuery(trpc)),
      queryClient.ensureQueryData(trpc.projects.list.queryOptions()),
      queryClient.ensureQueryData(trpc.organization.members.queryOptions()),
    ]).catch(() => undefined);
    // A read that fails here is the sidebar's to show, with Try again; the page still renders.
    if (typeof window === "undefined") await reads;
  },
  component: InboxLayout,
});

function InboxLayout() {
  // One event stream for the tab, joined here so every signed-in page is live.
  useWorkbenchEvents();
  const inbox = useInbox();
  const online = useOnline();
  const home = useLocation({ select: (location) => location.pathname === "/" });
  const settings = useLocation({ select: (location) => isSettingsPath(location.pathname) });
  const { organizationName, account } = useViewer();
  // Open in full or folded to its rail, as this browser left it; the server renders it that way.
  const expanded = sidebarExpanded.use();
  // On a wide screen the frame is the window, and the sheet takes what its margins leave, its
  // border included. A page fills the sheet (`lg:min-h-0 lg:flex-1`) and scrolls inside it, never
  // working out the window's height itself: a page sized to the window minus the margins left the
  // sheet's 1px border top and bottom over, 2px of scroll on every desktop page.
  return (
    <SidebarProvider
      open={expanded}
      onOpenChange={sidebarExpanded.set}
      style={{ "--sidebar-width": SIDEBAR_WIDTH, "--sidebar-width-icon": SIDEBAR_RAIL_WIDTH }}
      className="bg-canvas lg:h-dvh"
    >
      {/* Search from anywhere: ⌘K, the sidebar's field, the phone inbox's search. */}
      <SearchProvider organizationName={organizationName} inbox={inbox}>
        {/* A row's Stop session… opens this one dialog, which outlives the row moving. */}
        <StopSessionHost>
          {/* Under 1024px there is no sidebar: home is the inbox, and Settings holds the switchers. */}
          <div className="contents max-lg:hidden">
            {settings ? (
              <SettingsSidebar />
            ) : (
              <AppSidebar
                organizationName={organizationName}
                account={account}
                inbox={inbox}
                online={online}
              />
            )}
          </div>
          <SidebarInset className="min-h-0 min-w-0 lg:my-sheet-inset lg:mr-sheet-inset lg:rounded-xl lg:border lg:border-sheet-border lg:shadow-sheet">
            {home ? (
              <PhoneInbox
                organizationName={organizationName}
                inbox={inbox}
                online={online}
                className="lg:hidden"
              />
            ) : null}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col lg:overflow-y-auto",
                home && "max-lg:hidden",
              )}
            >
              <InSheet>
                <Outlet />
              </InSheet>
            </div>
          </SidebarInset>
        </StopSessionHost>
      </SearchProvider>
      <Toaster />
      <SwitchedToast />
    </SidebarProvider>
  );
}
