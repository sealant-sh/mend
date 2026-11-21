import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mend/ui/components/ui/tooltip";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleUserRoundIcon,
  LogOutIcon,
  MapIcon,
  SmartphoneIcon,
  SunMoonIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { authClient } from "#/lib/auth-client";
import { desktopBridge, useDesktopBridge } from "#/lib/desktop";
import { exposureDetail, exposureLine } from "#/lib/exposure";
import { fitsDialog } from "#/lib/how-mend-fits-open";
import { useServerHost } from "#/lib/online";
import { setThemePreference, type ThemePreference, useThemePreference } from "#/lib/theme";
import { useTRPC } from "#/lib/trpc";

import { SheetHandle, SheetItem, SheetItemBody, sheetItemClass } from "./sheet-item.tsx";

/**
 * The account menu (Doop "Account menu · Theme open", "Phone · account actions"): who is signed
 * in and how this server is reached, Profile, Pair a phone…, Theme, How Mend fits together (setup's
 * last step, opened again as a dialog), Docs and Sign out. On the desk
 * it opens from the account row at the foot of the sidebar, or the avatar on its rail; on a phone,
 * from the account row at the top of the Settings tab, as a sheet.
 *
 * The theme belongs to this browser (Settings → This device → Appearance shows the same choice):
 * it is kept under the old app's key, so a choice made there holds here.
 */

/** Who is signed in, as the account row and the menu name them. */
export interface Account {
  readonly name: string;
  readonly email: string;
}

const DOCS_URL = "https://docs.mend.run";

const THEMES: ReadonlyArray<{ readonly value: ThemePreference; readonly label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const themeLabel = (theme: ThemePreference): string =>
  THEMES.find((choice) => choice.value === theme)?.label ?? "System";

const isTheme = (value: unknown): value is ThemePreference =>
  THEMES.some((choice) => choice.value === value);

/** "AL" for Ada Lovelace; the first letter of the email when there is no name. */
export const accountInitials = ({ name, email }: Account): string => {
  const words = name.split(/\s+/).filter((word) => word !== "");
  const letters =
    words.length === 0 ? [email.charAt(0)] : [words[0]?.charAt(0), words.at(1)?.charAt(0)];
  return letters
    .filter((letter) => letter !== undefined)
    .join("")
    .toUpperCase();
};

/** The round avatar with the account's initials. */
export function AccountAvatar({
  account,
  size = "sm",
}: {
  readonly account: Account;
  readonly size?: "rail" | "sm" | "touch";
}) {
  const sizes = { rail: "size-7", sm: "size-7.5", touch: "size-10 text-sm" } as const;
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-sidebar-accent text-2xs font-semibold text-foreground",
        sizes[size],
      )}
    >
      {accountInitials(account)}
    </span>
  );
}

/**
 * Signing out: Better Auth ends the session, then the sign-in page loads afresh, so nothing the
 * account read stays in the page.
 */
export const useSignOut = () =>
  useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error !== null) throw new Error(result.error.message ?? "Signing out failed.");
      await desktopBridge()
        ?.setBadgeCount(0)
        .catch(() => undefined);
    },
    onSuccess: () => window.location.assign("/login"),
  });

/** How this server is reached: `exposure · private · https`. Nothing until the server says. */
function ExposureLine({ className }: { readonly className?: string }) {
  const trpc = useTRPC();
  const machine = useQuery(trpc.platform.machine.queryOptions(undefined, { staleTime: 30_000 }));
  // A report beside the name, not something to wait for: while it loads, or if it can't be read,
  // the menu goes without it. A server older than `exposure` has none to give.
  if (machine.isPending || machine.isError) return null;
  const exposure = machine.data.exposure;
  if (exposure === undefined) return null;
  return (
    <p title={exposureDetail(exposure)} className={className}>
      {exposureLine(exposure)}
    </p>
  );
}

export const SIGN_OUT_FAILED = "Mend didn't sign you out. Check your connection and try again.";

/** The trigger's place: the sidebar's account row, or the avatar on its rail. */
type Place = "sidebar" | "rail";

export function AccountMenu({
  account,
  place,
}: {
  readonly account: Account;
  readonly place: Place;
}) {
  const host = useServerHost();
  const desktop = useDesktopBridge();
  const theme = useThemePreference();
  const signOut = useSignOut();
  const leaving = signOut.isPending || signOut.isSuccess;
  // The menu item that opens How Mend fits together is gone once it closes: focus goes back to
  // the trigger.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = account.name === "" ? "Account" : `${account.name}, account`;
  const trigger =
    place === "sidebar" ? (
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={label}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg p-2 text-left outline-none hover:bg-background/55 focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-background/55"
      >
        <AccountAvatar account={account} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-row font-semibold">{account.name}</span>
          <span className="truncate text-meta text-muted-foreground">{host}</span>
        </span>
        <ChevronsUpDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              ref={triggerRef}
              aria-label={label}
              className="mt-1.5 mb-0.5 grid place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <AccountAvatar account={account} size="rail" />
        </TooltipTrigger>
        <TooltipContent side="right">
          {account.name === "" ? "Account" : account.name}
        </TooltipContent>
      </Tooltip>
    );
  return (
    <>
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent
          width={place === "sidebar" ? "anchor" : "md"}
          side={place === "sidebar" ? "top" : "right"}
          align={place === "sidebar" ? "start" : "end"}
          sideOffset={place === "sidebar" ? 6 : 8}
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate">
              {[account.name, account.email].filter((part) => part !== "").join(" · ")}
            </DropdownMenuLabel>
            <ExposureLine className="truncate px-2 pb-1 font-mono text-2xs text-muted-foreground" />
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link to="/settings/profile" />}>
            <CircleUserRoundIcon aria-hidden className="text-muted-foreground" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings/devices" />}>
            <SmartphoneIcon aria-hidden className="text-muted-foreground" />
            Pair a phone…
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SunMoonIcon aria-hidden className="text-muted-foreground" />
              <span className="flex-1">Theme</span>
              <span className="text-meta text-muted-foreground">{themeLabel(theme)}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent width="sm" sideOffset={8}>
              <DropdownMenuRadioGroup
                value={theme}
                onValueChange={(value: unknown) => {
                  if (isTheme(value)) setThemePreference(value);
                }}
              >
                {THEMES.map((choice) => (
                  <DropdownMenuRadioItem key={choice.value} value={choice.value} closeOnClick>
                    {choice.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => fitsDialog.open(triggerRef.current)}>
            <MapIcon aria-hidden className="text-muted-foreground" />
            How Mend fits together
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Docs, opens in a new tab"
              />
            }
          >
            <BookOpenIcon aria-hidden className="text-muted-foreground" />
            <span className="flex-1">Docs</span>
            <ArrowUpRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {desktop === null ? null : (
            <DropdownMenuItem onClick={() => void desktop.switchServer()}>
              <ArrowLeftRightIcon aria-hidden className="text-muted-foreground" />
              Switch server…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            closeOnClick={false}
            disabled={leaving}
            onClick={() => signOut.mutate()}
          >
            <LogOutIcon aria-hidden className="text-muted-foreground" />
            {leaving ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
          {signOut.isError ? (
            <p role="alert" className="px-2 pt-0.5 pb-1.5 text-meta text-destructive">
              {SIGN_OUT_FAILED}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

type PhonePage = "account" | "theme";

/**
 * The account row at the top of the phone's Settings tab (Doop "Phone · account actions"): the
 * avatar, the name and email, opening the account's actions as a sheet. Appearance is a second
 * page of the same sheet.
 */
export function PhoneAccountRow({ account }: { readonly account: Account }) {
  const navigate = useNavigate();
  const theme = useThemePreference();
  const signOut = useSignOut();
  const leaving = signOut.isPending || signOut.isSuccess;
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  const [page, setPage] = useState<PhonePage>("account");
  const show = (next: boolean) => {
    setOpen(next);
    if (next) setPage("account");
  };
  const go = (link: LinkProps) => {
    setOpen(false);
    void navigate(link);
  };
  return (
    <>
      <button
        ref={row}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${account.name === "" ? "Account" : account.name}, account`}
        onClick={() => show(true)}
        className="flex min-h-16 w-full items-center gap-3.5 border-b border-border px-4 py-3 text-left outline-none focus-visible:bg-muted active:bg-accent"
      >
        <AccountAvatar account={account} size="touch" />
        <span className="grid min-w-0 flex-1 leading-snug">
          <span className="truncate text-lead font-semibold">{account.name}</span>
          <span className="truncate text-sm text-muted-foreground">{account.email}</span>
        </span>
        <ChevronRightIcon aria-hidden className="size-4.5 shrink-0 text-muted-foreground" />
      </button>
      <Sheet open={open} onOpenChange={show}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHandle />
          {page === "account" ? (
            <>
              <PhoneSheetHeader title={account.name} subtitle={account.email}>
                <ExposureLine className="truncate font-mono text-xs text-muted-foreground" />
              </PhoneSheetHeader>
              <div role="menu" aria-label="Account" className="py-1">
                <SheetItem
                  icon={<CircleUserRoundIcon aria-hidden />}
                  chevron
                  onClick={() => go({ to: "/settings/profile" })}
                >
                  Profile
                </SheetItem>
                <SheetItem
                  icon={<SunMoonIcon aria-hidden />}
                  value={themeLabel(theme)}
                  chevron
                  onClick={() => setPage("theme")}
                >
                  Appearance
                </SheetItem>
                <SheetItem
                  icon={<MapIcon aria-hidden />}
                  chevron
                  onClick={() => {
                    setOpen(false);
                    fitsDialog.open(row.current);
                  }}
                >
                  How Mend fits together
                </SheetItem>
                <a
                  role="menuitem"
                  aria-label="Docs, opens in a new tab"
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={sheetItemClass}
                >
                  <SheetItemBody
                    icon={<BookOpenIcon aria-hidden />}
                    end={<ArrowUpRightIcon aria-hidden className="size-4" />}
                  >
                    Docs
                  </SheetItemBody>
                </a>
              </div>
              <div role="menu" aria-label="Sign out" className="border-t py-1">
                <SheetItem
                  icon={<LogOutIcon aria-hidden />}
                  disabled={leaving}
                  onClick={() => signOut.mutate()}
                >
                  {leaving ? "Signing out…" : "Sign out"}
                </SheetItem>
                {signOut.isError ? (
                  <p role="alert" className="px-5 pb-2 text-sm text-destructive">
                    {SIGN_OUT_FAILED}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <PhoneSheetHeader
                title="Appearance"
                subtitle="Only this browser"
                onBack={() => setPage("account")}
              />
              <div role="menu" aria-label="Theme" className="py-1">
                {THEMES.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === choice.value}
                    onClick={() => setThemePreference(choice.value)}
                    className={sheetItemClass}
                  >
                    <SheetItemBody
                      end={
                        theme === choice.value ? (
                          <CheckIcon aria-hidden className="size-4.5 text-foreground!" />
                        ) : null
                      }
                    >
                      {choice.label}
                    </SheetItemBody>
                  </button>
                ))}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function PhoneSheetHeader({
  title,
  subtitle,
  onBack,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly onBack?: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <SheetHeader
      className={cn(
        "flex-row items-center gap-1 border-b border-border py-2.5 pr-1.5",
        onBack === undefined ? "pl-5" : "pl-1.5",
      )}
    >
      {onBack === undefined ? null : (
        <Button type="button" variant="ghost" size="icon-touch" aria-label="Back" onClick={onBack}>
          <ChevronLeftIcon aria-hidden className="size-5.5" />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <SheetTitle className="truncate text-title font-semibold">{title}</SheetTitle>
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        {children}
      </div>
    </SheetHeader>
  );
}
