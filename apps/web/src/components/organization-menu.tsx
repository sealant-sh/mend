import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { toast } from "@mend/ui/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mend/ui/components/ui/tooltip";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Building2Icon,
  CheckIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import type { AccountOrganizationDto } from "#/lib/api";
import { laterPage } from "#/lib/later-pages";
import { useServerHost } from "#/lib/online";
import {
  leaveSwitchedNote,
  openHomeAfterSwitch,
  takeSwitchedNote,
  type SwitchedNote,
} from "#/lib/organization-switch";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { CreateOrganizationDialog, LeaveOrganizationDialog } from "./organization-dialogs.tsx";
import { SheetHandle, SheetItem, SheetItemBody, sheetItemClass } from "./sheet-item.tsx";

/**
 * The organization switcher (Doop "Organization switcher · open", "Phone · organization
 * switcher"): the organizations the signed-in account belongs to on this server, the one this
 * browser acts in checked, then that organization's settings. On the desk it opens from the
 * organization row at the top of the sidebar, or the mark on its rail; on a phone, from the
 * organization row at the top of the Settings tab, as a sheet.
 *
 * Choosing another organization switches this browser's sign-in and loads home in it
 * (`lib/organization-switch.ts`). After the settings item: "Create organization…", only where the
 * server lets this person create one (`canCreateOrganizations`), and "Leave <organization>…", only
 * for someone in more than one, since the server never lets anyone leave their only organization.
 * The frames also offer Leave on Organization General and on your own row in Members (route PRs
 * 45 and 46), which open the same dialog (`organization-dialogs.tsx`).
 */

/** The organization's mark: its first letter on a dark square. */
export function OrganizationMark({
  name,
  size = "sm",
}: {
  readonly name: string;
  readonly size?: "sm" | "touch";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center bg-foreground font-bold text-background",
        size === "touch" ? "size-10 rounded-lg text-lead" : "size-5.5 rounded-md text-xs",
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

const organizationsOptions = (trpc: ReturnType<typeof useTRPC>) =>
  trpc.organizations.list.queryOptions(undefined, { staleTime: 60_000 });

/** What the switcher offers after the settings item, from what the server says this person may do. */
const useMembershipActions = (organizations: ReadonlyArray<AccountOrganizationDto>) => {
  const trpc = useTRPC();
  const view = useQuery(signedInOptions(trpc));
  const current = organizations.find((membership) => membership.active);
  return {
    // Missing on an older server, or while it can't be read: no item, rather than a dead one.
    canCreate: view.status === "success" && view.data.canCreateOrganizations,
    leaving:
      current !== undefined && organizations.length > 1
        ? {
            organization: current.organization,
            others: organizations
              .filter((membership) => !membership.active)
              .map((membership) => membership.organization.name),
          }
        : null,
  };
};

/** Asks the switcher on screen to open: the toast after leaving offers "Switch organization". */
const OPEN_SWITCHER = "mend:open-organization-switcher";

const openSwitcher = (): void => {
  window.dispatchEvent(new Event(OPEN_SWITCHER));
};

/** What a refused switch says: the organization, then the server's reason. */
const refusalOf = (name: string, error: unknown): string => {
  const reason = error instanceof Error && error.message !== "" ? ` ${error.message}` : "";
  return `Mend couldn't switch to ${name}.${reason}`;
};

/**
 * The switch itself: the server moves this browser's sign-in, then home loads in the chosen
 * organization, with a note that says where the person came from.
 */
const useSwitchOrganization = (current: string, currentId: string | undefined) => {
  const trpc = useTRPC();
  return useMutation(
    trpc.organizations.switch.mutationOptions({
      onSuccess: (membership) => {
        if (currentId !== undefined)
          leaveSwitchedNote({
            kind: "switched",
            to: membership.organization.name,
            from: { id: currentId, name: current },
          });
        openHomeAfterSwitch();
      },
    }),
  );
};

/** The trigger's place: the sidebar's organization row, or the mark on its rail. */
type Place = "sidebar" | "rail";

export function OrganizationMenu({
  organizationName,
  place,
}: {
  readonly organizationName: string;
  readonly place: Place;
}) {
  const trpc = useTRPC();
  const host = useServerHost();
  const organizations = useQuery(organizationsOptions(trpc));
  const memberships = organizations.data ?? [];
  const current = memberships.find((membership) => membership.active);
  const switching = useSwitchOrganization(organizationName, current?.organization.id);
  // Once the server has switched, the page is already loading home.
  const busy = switching.isPending || switching.isSuccess;
  const target = switching.variables?.organizationId;
  const actions = useMembershipActions(memberships);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<"create" | "leave" | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The toast's "Switch organization" opens whichever switcher is on screen: the sidebar's row or
  // the rail's mark, never one hidden at this width.
  useEffect(() => {
    const open = () => {
      if (triggerRef.current?.offsetParent != null) setMenuOpen(true);
    };
    window.addEventListener(OPEN_SWITCHER, open);
    return () => window.removeEventListener(OPEN_SWITCHER, open);
  }, []);
  const label = `${organizationName}, switch organization`;
  const trigger =
    place === "sidebar" ? (
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={label}
        className="flex h-9 w-full min-w-0 items-center gap-2.25 rounded-lg px-2 text-left text-prose font-semibold outline-none hover:bg-background/55 focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-background/55"
      >
        <OrganizationMark name={organizationName} />
        <span className="min-w-0 flex-1 truncate">{organizationName}</span>
        <ChevronsUpDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              ref={triggerRef}
              aria-label={label}
              className="grid h-10 w-8 shrink-0 place-items-center rounded-lg outline-none hover:bg-background/55 focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-background/55"
            />
          }
        >
          <OrganizationMark name={organizationName} />
        </TooltipTrigger>
        <TooltipContent side="right">{organizationName}</TooltipContent>
      </Tooltip>
    );
  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {trigger}
        <DropdownMenuContent
          width="lg"
          side={place === "sidebar" ? "bottom" : "right"}
          align="start"
          sideOffset={place === "sidebar" ? 4 : 8}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate">
              {host === "" ? "Your organizations" : `Organizations on ${host}`}
            </DropdownMenuLabel>
            {organizations.isPending ? (
              <p role="status" className="px-2 py-1.5 text-row text-muted-foreground">
                Loading your organizations…
              </p>
            ) : organizations.isError ? (
              <>
                <p role="alert" className="px-2 py-1.5 text-row text-muted-foreground">
                  Your organizations didn't load.
                </p>
                <DropdownMenuItem closeOnClick={false} onClick={() => void organizations.refetch()}>
                  {organizations.isRefetching ? "Trying again…" : "Try again"}
                </DropdownMenuItem>
              </>
            ) : (
              memberships.map((membership) => (
                <DropdownMenuItem
                  key={membership.organization.id}
                  closeOnClick={membership.active}
                  disabled={busy && !membership.active}
                  aria-current={membership.active ? "true" : undefined}
                  onClick={() => {
                    if (!membership.active)
                      switching.mutate({ organizationId: membership.organization.id });
                  }}
                >
                  <Building2Icon aria-hidden className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{membership.organization.name}</span>
                  <MembershipEnd
                    membership={membership}
                    switching={busy && target === membership.organization.id}
                  />
                </DropdownMenuItem>
              ))
            )}
            {switching.isError ? (
              <p role="alert" className="px-2 py-1.5 text-meta text-destructive">
                {refusalOf(
                  memberships.find((m) => m.organization.id === target)?.organization.name ??
                    "that organization",
                  switching.error,
                )}
              </p>
            ) : null}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link {...laterPage("settings/organization")} />}>
            <SettingsIcon aria-hidden className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{organizationName} settings</span>
          </DropdownMenuItem>
          {actions.canCreate ? (
            <DropdownMenuItem onClick={() => setDialog("create")}>
              <PlusIcon aria-hidden className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Create organization…</span>
            </DropdownMenuItem>
          ) : null}
          {actions.leaving === null ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDialog("leave")}>
                <LogOutIcon aria-hidden />
                <span className="min-w-0 flex-1 truncate">Leave {organizationName}…</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <MembershipDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        current={organizationName}
        leaving={actions.leaving}
        finalFocus={triggerRef}
      />
    </>
  );
}

/** The dialogs the switcher's last items open, on the desk or from the phone's sheet. */
function MembershipDialogs({
  dialog,
  onClose,
  current,
  leaving,
  finalFocus,
}: {
  readonly dialog: "create" | "leave" | null;
  readonly onClose: () => void;
  readonly current: string;
  readonly leaving: ReturnType<typeof useMembershipActions>["leaving"];
  readonly finalFocus: RefObject<HTMLElement | null>;
}) {
  const host = useServerHost();
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <>
      <CreateOrganizationDialog
        open={dialog === "create"}
        onOpenChange={onOpenChange}
        current={current}
        host={host}
        finalFocus={finalFocus}
      />
      {leaving === null ? null : (
        <LeaveOrganizationDialog
          open={dialog === "leave"}
          onOpenChange={onOpenChange}
          organization={leaving.organization}
          others={leaving.others}
          finalFocus={finalFocus}
        />
      )}
    </>
  );
}

/** The right of an organization's item: the check on the current one, or "Switching…". */
function MembershipEnd({
  membership,
  switching,
}: {
  readonly membership: AccountOrganizationDto;
  readonly switching: boolean;
}) {
  if (membership.active) return <CheckIcon aria-label="Current" className="ml-auto" />;
  if (switching)
    return (
      <span role="status" className="ml-auto pl-3 text-meta text-muted-foreground">
        Switching…
      </span>
    );
  return null;
}

/**
 * The organization row at the top of the phone's Settings tab (Doop "Phone · organization
 * switcher"): the mark, the name and the server, opening the switcher as a sheet.
 */
export function PhoneOrganizationRow({ organizationName }: { readonly organizationName: string }) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const host = useServerHost();
  const [open, setOpen] = useState(false);
  const organizations = useQuery(organizationsOptions(trpc));
  const memberships = organizations.data ?? [];
  const current = memberships.find((membership) => membership.active);
  const switching = useSwitchOrganization(organizationName, current?.organization.id);
  const busy = switching.isPending || switching.isSuccess;
  const target = switching.variables?.organizationId;
  const actions = useMembershipActions(memberships);
  const [dialog, setDialog] = useState<"create" | "leave" | null>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const openDialog = (next: "create" | "leave") => {
    setOpen(false);
    setDialog(next);
  };
  return (
    <>
      <button
        ref={rowRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${organizationName}, switch organization`}
        onClick={() => setOpen(true)}
        className="flex min-h-16 w-full items-center gap-3.5 border-b border-border px-4 py-3 text-left outline-none focus-visible:bg-muted active:bg-accent"
      >
        <OrganizationMark name={organizationName} size="touch" />
        <span className="grid min-w-0 flex-1 leading-snug">
          <span className="truncate text-lead font-semibold">{organizationName}</span>
          <span className="truncate text-sm text-muted-foreground">{host}</span>
        </span>
        <ChevronsUpDownIcon aria-hidden className="size-4.5 shrink-0 text-muted-foreground" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHandle />
          <SheetHeader className="gap-0 border-b border-border px-5 py-2.5">
            <SheetTitle className="text-title font-semibold">Organizations</SheetTitle>
            {host === "" ? null : <p className="text-sm text-muted-foreground">On {host}</p>}
          </SheetHeader>
          <div role="menu" aria-label="Organizations" className="py-1">
            {organizations.isPending ? (
              <p role="status" className="px-5 py-3.5 text-lead text-muted-foreground">
                Loading your organizations…
              </p>
            ) : organizations.isError ? (
              <>
                <p role="alert" className="px-5 pt-3.5 text-lead text-muted-foreground">
                  Your organizations didn't load.
                </p>
                <SheetItem onClick={() => void organizations.refetch()}>
                  {organizations.isRefetching ? "Trying again…" : "Try again"}
                </SheetItem>
              </>
            ) : (
              memberships.map((membership) => (
                <SheetItem
                  key={membership.organization.id}
                  icon={<Building2Icon aria-hidden />}
                  disabled={busy && !membership.active}
                  onClick={() => {
                    if (membership.active) setOpen(false);
                    else switching.mutate({ organizationId: membership.organization.id });
                  }}
                  end={
                    <MembershipEnd
                      membership={membership}
                      switching={busy && target === membership.organization.id}
                    />
                  }
                >
                  {membership.organization.name}
                </SheetItem>
              ))
            )}
            {switching.isError ? (
              <p role="alert" className="px-5 pb-2 text-sm text-destructive">
                {refusalOf(
                  memberships.find((m) => m.organization.id === target)?.organization.name ??
                    "that organization",
                  switching.error,
                )}
              </p>
            ) : null}
          </div>
          <div role="menu" aria-label={`${organizationName} settings`} className="border-t py-1">
            <button
              type="button"
              role="menuitem"
              className={sheetItemClass}
              onClick={() => {
                setOpen(false);
                void navigate(laterPage("settings/organization"));
              }}
            >
              <SheetItemBody icon={<SettingsIcon aria-hidden />} chevron>
                {organizationName} settings
              </SheetItemBody>
            </button>
            {actions.canCreate ? (
              <SheetItem icon={<PlusIcon aria-hidden />} onClick={() => openDialog("create")}>
                Create organization…
              </SheetItem>
            ) : null}
          </div>
          {actions.leaving === null ? null : (
            <div role="menu" aria-label={`Leave ${organizationName}`} className="border-t py-1">
              <SheetItem
                icon={<LogOutIcon aria-hidden />}
                className="text-destructive [&_svg]:text-destructive"
                onClick={() => openDialog("leave")}
              >
                Leave {organizationName}…
              </SheetItem>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <MembershipDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        current={organizationName}
        leaving={actions.leaving}
        finalFocus={rowRef}
      />
    </>
  );
}

/**
 * After the sign-in moved and home loaded, once, on the page it loaded: "Switched to Acme Labs."
 * with "Back to Northwind" (Doop "Phone · Inbox · switched to Acme Labs"), "Created Difference
 * Engine. You're its owner." ("Organizations · new organization, empty"), or "You left Northwind.
 * You're now in Acme Labs." with "Switch organization" on the desk ("Members · left Northwind").
 */
export function SwitchedToast() {
  const client = useTRPCClient();
  useEffect(() => {
    // The note lives in this tab's storage, so it can only be read once the page is in a browser.
    const note = takeSwitchedNote();
    if (note !== null) showSwitched(note, client);
  }, [client]);
  return null;
}

const showSwitched = (note: SwitchedNote, client: ReturnType<typeof useTRPCClient>) => {
  if (note.kind === "created") {
    toast.add({ description: `Created ${note.name}. You're its owner.` });
    return;
  }
  if (note.kind === "left") {
    const where = note.now === null ? "" : ` You're now in ${note.now}.`;
    // On a phone the switcher is a row on the Settings tab, not on this page: no action there.
    const desk = window.matchMedia("(min-width: 1024px)").matches;
    toast.add({
      description: `You left ${note.left}.${where}`,
      ...(desk
        ? {
            priority: "low" as const,
            actionProps: { children: "Switch organization", onClick: openSwitcher },
          }
        : {}),
    });
    return;
  }
  toast.add({
    description: `Switched to ${note.to}.`,
    // An action a screen reader can reach: read out politely, not at once.
    priority: "low",
    actionProps: {
      children: `Back to ${note.from.name}`,
      onClick: () => {
        // Going back undoes the switch: home loads with nothing more to say.
        client.organizations.switch
          .mutate({ organizationId: note.from.id })
          .then(openHomeAfterSwitch)
          .catch((error: unknown) => {
            toast.add({ description: refusalOf(note.from.name, error), priority: "high" });
          });
      },
    },
  });
};
