import type { OrganizationViewDto } from "./api.ts";

/**
 * The tabs of Settings: You (everyone), Organization (anyone in one; some tabs owners only) and
 * Instance (the operator only, docs/adr/0003). Every tab has its own URL; the header a tab shows
 * lives here so the settings layout draws it once, above the tab line.
 */
export type SettingsGroup = "you" | "organization" | "instance";

export type SettingsPath =
  | "/settings/account"
  | "/settings/workspace"
  | "/settings/git-access"
  | "/settings/sessions"
  | "/settings/review"
  | "/settings/landing"
  | "/settings/devices"
  | "/settings/sealant"
  | "/settings/organization/members"
  | "/settings/organization/invitations"
  | "/settings/organization/defaults"
  | "/settings/organization/environment"
  | "/settings/organization/slack"
  | "/settings/organization/folders"
  | "/settings/organization/projects"
  | "/settings/organization/audit-log"
  | "/settings/instance/environment"
  | "/settings/instance/defaults"
  | "/settings/instance/exposure";

export interface SettingsTab {
  readonly group: SettingsGroup;
  readonly to: SettingsPath;
  readonly label: string;
  readonly title: string;
  /** The line under the title. `{organization}` becomes the organization's name. */
  readonly description: string;
  /** Owners only, inside Organization. */
  readonly ownersOnly?: true;
}

export const SETTINGS_TABS: ReadonlyArray<SettingsTab> = [
  {
    group: "you",
    to: "/settings/account",
    label: "Account",
    title: "Account",
    description: "Your sign-in, your agent logins and how Mend looks.",
  },
  {
    group: "you",
    to: "/settings/workspace",
    label: "Workspace",
    title: "Workspace",
    description:
      "What every new session starts with. Running sessions keep what they started with.",
  },
  {
    group: "you",
    to: "/settings/git-access",
    label: "Git access",
    title: "Git access",
    description: "How your sessions push and fetch, and who commits.",
  },
  {
    group: "you",
    to: "/settings/sessions",
    label: "Sessions",
    title: "Sessions",
    description: "How your sessions run and take messages.",
  },
  {
    group: "you",
    to: "/settings/review",
    label: "Review",
    title: "Review",
    description: "What Mend does with each change. Mend uses inference for these.",
  },
  {
    group: "you",
    to: "/settings/landing",
    label: "Landing",
    title: "Landing",
    description: "When Mend pushes a change and opens its pull request.",
  },
  {
    group: "you",
    to: "/settings/devices",
    label: "Devices",
    title: "Devices",
    description: "Phones and machines signed in as you.",
  },
  {
    group: "you",
    to: "/settings/sealant",
    label: "Sealant",
    title: "Sealant",
    description: "The runtime Mend uses for workspaces, recordings and model calls.",
  },
  {
    group: "organization",
    to: "/settings/organization/members",
    label: "Members",
    title: "Members",
    description: "People in {organization} and their roles. Owners manage members.",
  },
  {
    group: "organization",
    to: "/settings/organization/invitations",
    label: "Invitations",
    title: "Invitations",
    description: "Registration is closed. People join with a single-use link.",
    ownersOnly: true,
  },
  {
    group: "organization",
    to: "/settings/organization/defaults",
    label: "Defaults",
    title: "Defaults",
    description: "What every project in {organization} starts with unless it sets its own.",
  },
  {
    group: "organization",
    to: "/settings/organization/environment",
    label: "Environment",
    title: "Environment",
    description: "The workspace environment for everyone in {organization}.",
  },
  {
    group: "organization",
    to: "/settings/organization/slack",
    label: "Slack",
    title: "Slack",
    description:
      "{organization}'s own Slack app. People ask @mend in threads; Mend reports back there.",
  },
  {
    group: "organization",
    to: "/settings/organization/folders",
    label: "Folders",
    title: "Folders",
    description: "Mend-managed folders projects can mount.",
  },
  {
    group: "organization",
    to: "/settings/organization/projects",
    label: "Projects",
    title: "Projects",
    description: "Projects that need an owner, and volumes kept from removed projects.",
    ownersOnly: true,
  },
  {
    group: "organization",
    to: "/settings/organization/audit-log",
    label: "Audit log",
    title: "Audit log",
    description: "Every change to members, settings and access in {organization}.",
    ownersOnly: true,
  },
  {
    group: "instance",
    to: "/settings/instance/environment",
    label: "Environment",
    title: "Environment",
    description:
      "Defaults for this machine. Operators administer it and see no organization content by default.",
  },
  {
    group: "instance",
    to: "/settings/instance/defaults",
    label: "Defaults",
    title: "Defaults",
    description:
      "What every organization on this machine inherits unless it sets its own. Operators only.",
  },
  {
    group: "instance",
    to: "/settings/instance/exposure",
    label: "Exposure",
    title: "Exposure",
    description: "How people reach this instance: what was declared beside what Mend observed.",
  },
];

/** What a viewer may open: Organization needs an organization, Instance the operator. */
export interface SettingsAccess {
  readonly organization: "owner" | "member" | null;
  readonly operator: boolean;
}

export const settingsAccess = (view: OrganizationViewDto | undefined): SettingsAccess => ({
  organization: view === undefined ? null : view.role,
  operator: view?.operator === true,
});

export const visibleTabs = (
  group: SettingsGroup,
  access: SettingsAccess,
): ReadonlyArray<SettingsTab> =>
  SETTINGS_TABS.filter(
    (tab) =>
      tab.group === group &&
      (group === "you" ||
        (group === "organization" &&
          access.organization !== null &&
          (tab.ownersOnly !== true || access.organization === "owner")) ||
        (group === "instance" && access.operator)),
  );

/** The tab a path shows, or null for a path that is not one (the bare `/settings`). */
export const tabAt = (pathname: string): SettingsTab | null =>
  SETTINGS_TABS.find((tab) => pathname === tab.to || pathname === `${tab.to}/`) ?? null;

export const tabDescription = (tab: SettingsTab, organizationName: string | null): string =>
  tab.description.replaceAll("{organization}", organizationName ?? "your organization");

/**
 * Where an old single-page anchor (`/settings#devices`, from Slack messages and older links)
 * lands now. Unknown or missing anchors open Account.
 */
export const LEGACY_ANCHORS: Readonly<Record<string, SettingsPath>> = {
  accounts: "/settings/account",
  devices: "/settings/devices",
  "git-access": "/settings/git-access",
  landing: "/settings/landing",
  slack: "/settings/organization/slack",
  "organization-environment": "/settings/organization/environment",
  "organization-defaults": "/settings/organization/defaults",
};

export const legacyAnchorTarget = (hash: string): SettingsPath =>
  LEGACY_ANCHORS[hash.replace(/^#/, "")] ?? "/settings/account";
