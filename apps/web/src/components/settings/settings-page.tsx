import { cn } from "@mend/ui/lib/utils";
import {
  FolderGit2Icon,
  MonitorIcon,
  ServerIcon,
  ShieldIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

import {
  audienceLine,
  crumbsOf,
  groupName,
  type SettingsAudience,
  type SettingsNames,
  settingsPage,
  type SettingsPageId,
} from "#/lib/settings-pages";
import { useViewer } from "#/lib/use-viewer";

import { PhoneHeader } from "../workspace/phone-header.tsx";

const AUDIENCE_ICONS: Record<SettingsAudience, ReactNode> = {
  you: <UserRoundIcon />,
  browser: <MonitorIcon />,
  organization: <UsersRoundIcon />,
  owners: <ShieldIcon />,
  project: <FolderGit2Icon />,
  operators: <ServerIcon />,
};

/**
 * One settings page (Doop "Settings breadcrumb" and the title block under it): on the desk, the
 * 52px breadcrumb row ("Settings / Account / Profile"), then in the 880px column the title, the
 * audience line with its icon (docs/adr/0025, decision 6) and one intro sentence, then the page's
 * rows. Under 1024px, the phone header (Back to Settings, the page and its group) takes the
 * breadcrumb's and the title's place.
 *
 * The page's name, group and audience come from `lib/settings-pages.ts`; a project's page passes
 * the project's name. The body scrolls inside the sheet.
 */
export function SettingsPage({
  page: id,
  projectName,
  intro,
  banner,
  children,
}: {
  readonly page: SettingsPageId;
  readonly projectName?: string;
  readonly intro: ReactNode;
  /** A state that lasts, over the whole page (a key about to expire): a Banner, under the header. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
}) {
  const { organizationName } = useViewer();
  const page = settingsPage(id);
  const names: SettingsNames = { organization: organizationName, project: projectName };
  const crumbs = crumbsOf(page, names);
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-2*var(--spacing-sheet-inset))] lg:flex-none">
      <PhoneHeader
        title={page.label}
        sub={page.group === "project" ? (projectName ?? "") : groupName(page.group, names)}
        back={{ link: { to: "/settings" }, label: "Settings" }}
        className="lg:hidden"
      />
      <nav
        aria-label="Breadcrumb"
        className="flex h-header shrink-0 items-center border-b border-border px-6 text-prose text-muted-foreground max-lg:hidden"
      >
        <ol className="flex min-w-0 items-center gap-2">
          <li>Settings</li>
          {crumbs.map((crumb) => {
            const last = crumb.key === "page";
            return (
              <Fragment key={crumb.key}>
                <li aria-hidden className="text-faint">
                  /
                </li>
                <li
                  aria-current={last ? "page" : undefined}
                  className={cn("truncate", last && "font-semibold text-foreground")}
                >
                  {crumb.label}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </nav>
      {banner}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-settings pb-16 lg:px-8 lg:pt-9">
          <header className="max-lg:px-4 max-lg:pt-3">
            <h1 className="text-page font-semibold tracking-tight max-lg:hidden">{page.label}</h1>
            <p className="mt-1.5 flex items-center gap-1.5 text-row text-muted-foreground max-lg:mt-0 [&_svg]:size-3.5 [&_svg]:shrink-0">
              {AUDIENCE_ICONS[page.audience]}
              {audienceLine(page.audience, names)}
            </p>
            <p className="mt-1 text-prose text-pretty text-foreground-2">{intro}</p>
          </header>
          <div className="mt-9 max-lg:mt-7">{children}</div>
        </div>
      </div>
    </div>
  );
}
