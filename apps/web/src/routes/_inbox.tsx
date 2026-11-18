import { SidebarInset, SidebarProvider } from "@mend/ui/components/ui/sidebar";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { AppSidebar, SIDEBAR_WIDTH } from "#/components/app-sidebar";
import { PhoneInbox } from "#/components/phone-inbox";
import { InSheet } from "#/components/route-screens";
import { Toaster } from "#/components/toaster";
import { inboxQuery } from "#/lib/inbox-live";
import { useOnline } from "#/lib/online";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { inboxMarksQuery, useInbox } from "#/lib/use-inbox";
import { useWorkbenchEvents } from "#/lib/workbench-events";

/**
 * The frame around every signed-in page: the desk, the sidebar on it (the only inbox), and the
 * sheet the page sits on. The sidebar is rendered here once, so moving between pages never
 * remounts it; only the sheet changes.
 *
 * Under 1024px there is no sidebar: home is the inbox as its own screen, with the tab bar, and
 * every other page takes the whole width. The New session composer, home's sheet on a wide
 * screen, is `/new` there.
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
  const trpc = useTRPC();
  // One event stream for the tab, joined here so every signed-in page is live.
  useWorkbenchEvents();
  const inbox = useInbox();
  const online = useOnline();
  const home = useLocation({ select: (location) => location.pathname === "/" });
  // The root route read who is signed in before this rendered; the roster names them. Until the
  // roster answers, or if it can't, the account row shows the server's address alone.
  const viewer = useSuspenseQuery(signedInOptions(trpc));
  const members = useQuery(trpc.organization.members.queryOptions());
  const organizationName = viewer.data.organization.name;
  // A roster that failed to read again keeps the names it had.
  const roster =
    members.isPending || (members.isError && members.data === undefined) ? [] : members.data;
  const accountName = roster?.find((member) => member.userId === viewer.data.userId)?.name ?? "";
  return (
    <SidebarProvider style={{ "--sidebar-width": SIDEBAR_WIDTH }} className="bg-canvas">
      <AppSidebar
        organizationName={organizationName}
        accountName={accountName}
        inbox={inbox}
        online={online}
        className="max-lg:hidden"
      />
      <SidebarInset className="min-w-0 lg:my-sheet-inset lg:mr-sheet-inset lg:rounded-xl lg:border lg:border-sheet-border lg:shadow-sheet">
        {home ? (
          <PhoneInbox
            organizationName={organizationName}
            inbox={inbox}
            online={online}
            className="lg:hidden"
          />
        ) : null}
        <div className={cn("flex min-h-0 flex-1 flex-col", home && "max-lg:hidden")}>
          <InSheet>
            <Outlet />
          </InSheet>
        </div>
      </SidebarInset>
      <Toaster />
    </SidebarProvider>
  );
}
