import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronRightIcon, FolderGit2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { groupName, type SettingsGroup, visiblePages } from "#/lib/settings-pages";
import { useInbox } from "#/lib/use-inbox";
import { useViewer } from "#/lib/use-viewer";

import { PhoneAccountRow } from "../account-menu.tsx";
import { PhoneOrganizationRow } from "../organization-menu.tsx";
import { PhoneTabBar } from "../phone-inbox.tsx";
import { SETTINGS_ICONS, settingsLink } from "./settings-links.tsx";
import { useSettingsNav } from "./settings-sidebar.tsx";

/**
 * The phone's Settings tab (Doop "Phone · Settings"): at its top the account row (the account's
 * actions) and the organization row (the switcher), then every page this person may open, grouped
 * as the desk's settings sidebar groups them, each project by name, and Server for its operators.
 * Each row opens its page.
 */
export function PhoneSettings() {
  const { account } = useViewer();
  const { viewer, organizationName, members, projects } = useSettingsNav();
  const inbox = useInbox();
  const waiting = inbox.status === "success" ? inbox.view.groups.waiting.length : 0;
  const names = { organization: organizationName };
  const group = (key: SettingsGroup) => (
    <PhoneGroup key={key} label={groupName(key, names)}>
      {visiblePages(key, viewer).map((page) => (
        <PhoneRow
          key={page.id}
          link={settingsLink(page.id)}
          icon={SETTINGS_ICONS[page.id]}
          count={page.id === "o-members" ? members : undefined}
        >
          {page.label}
        </PhoneRow>
      ))}
    </PhoneGroup>
  );
  return (
    <div className="flex min-h-dvh flex-col bg-background pb-14">
      <header className="px-4 pt-3 pb-3">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>
      <div className="border-t border-border">
        <PhoneAccountRow account={account} />
        <PhoneOrganizationRow organizationName={organizationName} />
      </div>
      {group("account")}
      {group("device")}
      {group("organization")}
      {projects.length === 0 ? null : (
        <PhoneGroup label="Projects">
          {projects.map((project) => (
            <PhoneRow
              key={project.id}
              link={settingsLink("p-general", project.id)}
              icon={<FolderGit2Icon />}
            >
              {project.name}
            </PhoneRow>
          ))}
        </PhoneGroup>
      )}
      {viewer.operator ? group("server") : null}
      <PhoneTabBar active="settings" badge={waiting} />
    </div>
  );
}

function PhoneGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section aria-label={label}>
      <h2 className="border-b border-border px-4 pt-6 pb-2 text-sm font-semibold text-muted-foreground">
        {label}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

/** One page: its icon, its name, a count for Members, and the chevron; 60px tall. */
function PhoneRow({
  link,
  icon,
  count,
  children,
}: {
  readonly link: LinkProps;
  readonly icon: ReactNode;
  readonly count?: number | undefined;
  readonly children: string;
}) {
  return (
    <li>
      <Link
        {...link}
        aria-label={count === undefined ? undefined : `${children}, ${count}`}
        className="flex h-15 items-center gap-3.5 border-b border-border px-4 text-lead outline-none focus-visible:bg-muted active:bg-accent [&_svg]:size-5 [&_svg]:shrink-0"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count === undefined ? null : (
          <span aria-hidden className="text-sm text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
        <ChevronRightIcon aria-hidden className="size-4! text-muted-foreground" />
      </Link>
    </li>
  );
}
