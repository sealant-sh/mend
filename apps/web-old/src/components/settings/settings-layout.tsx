import { Outlet, useLocation } from "@tanstack/react-router";

import { Page, PageHeader } from "#/components/kit/page";
import {
  TabGroup,
  TabGroupLink,
  TabGroupToggle,
  TabLine,
  TabLink,
  TabSpacer,
} from "#/components/kit/tab-line";
import { AppShell } from "#/components/shell";
import {
  settingsAccess,
  tabAt,
  tabDescription,
  visibleTabs,
  type SettingsAccess,
  type SettingsGroup,
  type SettingsTab,
} from "#/lib/settings-tabs";
import { useSignedInQuery } from "#/lib/viewer";

/**
 * Settings: the header of the tab on show, the tab line, and the tab itself. The You tabs sit on
 * the line; Organization and Instance are links that open their own tabs inline on the same line
 * while You folds to one link back. Which groups show depends on who is looking.
 */
export function SettingsLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const tab = tabAt(pathname);
  const current = useSignedInQuery();
  const access = settingsAccess(current.data);
  return (
    <AppShell layout="bare">
      <Page
        head={
          <>
            {tab === null ? null : (
              <PageHeader
                title={tab.title}
                description={tabDescription(tab, current.data?.organization.name ?? null)}
              />
            )}
            <SettingsTabLine group={tab?.group ?? "you"} access={access} />
          </>
        }
      >
        <Outlet />
      </Page>
    </AppShell>
  );
}

function SettingsTabLine({
  group,
  access,
}: {
  readonly group: SettingsGroup;
  readonly access: SettingsAccess;
}) {
  const organization = visibleTabs("organization", access);
  const instance = visibleTabs("instance", access);
  return (
    <TabLine label="Settings" className="mb-[22px]">
      {group === "you" ? (
        visibleTabs("you", access).map((tab) => (
          <TabLink key={tab.to} to={tab.to}>
            {tab.label}
          </TabLink>
        ))
      ) : (
        <GroupToggle tabs={visibleTabs("you", access)} label="You" />
      )}
      {group === "organization" ? (
        <OpenGroup label="Organization" tabs={organization} />
      ) : group === "instance" ? (
        <GroupToggle tabs={organization} label="Organization" />
      ) : null}
      <TabSpacer />
      {group === "you" ? <GroupToggle tabs={organization} label="Organization" /> : null}
      {group === "instance" ? (
        <OpenGroup label="Instance" tabs={instance} />
      ) : (
        <GroupToggle tabs={instance} label="Instance" />
      )}
    </TabLine>
  );
}

/** A folded group: one link to its first tab, or nothing when the viewer has none of its tabs. */
function GroupToggle({
  tabs,
  label,
}: {
  readonly tabs: ReadonlyArray<SettingsTab>;
  readonly label: string;
}) {
  const first = tabs[0];
  if (first === undefined) return null;
  return <TabGroupToggle to={first.to}>{label}</TabGroupToggle>;
}

function OpenGroup({
  label,
  tabs,
}: {
  readonly label: string;
  readonly tabs: ReadonlyArray<SettingsTab>;
}) {
  return (
    <TabGroup label={label}>
      {tabs.map((tab) => (
        <TabGroupLink key={tab.to} to={tab.to}>
          {tab.label}
        </TabGroupLink>
      ))}
    </TabGroup>
  );
}
