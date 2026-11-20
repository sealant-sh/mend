/**
 * Every page of Settings (docs/adr/0025, Doop "Settings sidebar"): its group, its address, who it
 * is for and who may open it. The settings sidebar, the phone's Settings tab, the breadcrumb, the
 * audience line and the guards all read this one list, so a page is described once.
 *
 * Every setting has one home (ADR 0025): You (Account), This device, the organization, a project,
 * and the Server, which only its operators see.
 */

/** The page ids the canvas's Settings sidebar names (its `page` prop). */
export type SettingsPageId =
  | "a-profile"
  | "a-logins"
  | "a-devices"
  | "a-dotfiles"
  | "a-mcp"
  | "a-notifications"
  | "a-automation"
  | "a-apps"
  | "d-appearance"
  | "o-general"
  | "o-members"
  | "o-image"
  | "o-runtime"
  | "o-boat"
  | "o-integrations"
  | "o-folders"
  | "o-projects"
  | "o-audit"
  | "p-general"
  | "p-workspace"
  | "p-services"
  | "p-secrets"
  | "p-folders"
  | "p-only-you"
  | "s-server";

/** The sidebar's groups, in its order. */
export type SettingsGroup = "account" | "device" | "organization" | "project" | "server";

/** Who a page's values reach: the muted line under its title. */
export type SettingsAudience =
  | "you"
  | "browser"
  | "organization"
  | "owners"
  | "project"
  | "operators";

/** Who may open a page at all. Anyone else doesn't see it listed, and is refused by address. */
export type SettingsAccess = "everyone" | "owners" | "operators";

export interface SettingsPage {
  readonly id: SettingsPageId;
  readonly group: SettingsGroup;
  /** The page's name: its sidebar entry, its title and the breadcrumb's last crumb. */
  readonly label: string;
  /**
   * Where it lives: under `/settings/` for every group but a project's, whose pages are
   * `/projects/<id>/settings/<slug>`.
   */
  readonly slug: string;
  readonly audience: SettingsAudience;
  readonly access: SettingsAccess;
}

/** One page, with its audience and access from its home. */
const entry = (
  id: SettingsPageId,
  group: SettingsGroup,
  label: string,
  slug: string,
): SettingsPage => ({ id, group, label, slug, ...homeOf(id, group) });

export const SETTINGS_PAGES: ReadonlyArray<SettingsPage> = [
  entry("a-profile", "account", "Profile", "profile"),
  entry("a-logins", "account", "Agent logins and Git", "agent-logins"),
  entry("a-devices", "account", "Devices and access keys", "devices"),
  entry("a-dotfiles", "account", "Dotfiles", "dotfiles"),
  entry("a-mcp", "account", "MCP servers", "mcp-servers"),
  entry("a-notifications", "account", "Notifications", "notifications"),
  entry("a-automation", "account", "Your automation", "automation"),
  entry("a-apps", "account", "Connected apps", "connected-apps"),
  entry("d-appearance", "device", "Appearance", "appearance"),
  entry("o-general", "organization", "General", "organization"),
  entry("o-members", "organization", "Members", "organization/members"),
  entry("o-image", "organization", "Workspace image", "organization/workspace-image"),
  entry("o-runtime", "organization", "Runtime", "organization/runtime"),
  entry("o-boat", "organization", "Boat", "organization/boat"),
  entry("o-integrations", "organization", "Integrations", "organization/integrations"),
  entry("o-folders", "organization", "Folders and references", "organization/folders"),
  entry("o-projects", "organization", "Projects", "organization/projects"),
  entry("o-audit", "organization", "Audit log", "organization/audit-log"),
  entry("p-general", "project", "General", "general"),
  entry("p-workspace", "project", "Workspace", "workspace"),
  entry("p-services", "project", "Services", "services"),
  entry("p-secrets", "project", "Variables and secrets", "secrets"),
  entry("p-folders", "project", "Folders and references", "folders"),
  entry("p-only-you", "project", "Only you", "only-you"),
  entry("s-server", "server", "Server", "server"),
];

/**
 * Who a page is for, from its home (ADR 0025, decision 6), and who may open it. The organization's
 * Projects page (projects whose creator left, kept volumes) and its Audit log are its owners'; a
 * project's "Only you" is yours alone, though it sits inside the project.
 */
function homeOf(
  id: SettingsPageId,
  group: SettingsGroup,
): { readonly audience: SettingsAudience; readonly access: SettingsAccess } {
  if (id === "o-projects" || id === "o-audit") return { audience: "owners", access: "owners" };
  if (id === "p-only-you") return { audience: "you", access: "everyone" };
  const audiences: Record<SettingsGroup, SettingsAudience> = {
    account: "you",
    device: "browser",
    organization: "organization",
    project: "project",
    server: "operators",
  };
  return {
    audience: audiences[group],
    access: group === "server" ? "operators" : "everyone",
  };
}

export const settingsPage = (id: SettingsPageId): SettingsPage => {
  const found = SETTINGS_PAGES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No settings page ${id}`);
  return found;
};

/** A page's address. A project's page needs the project. */
export const settingsPathOf = (page: SettingsPage, projectId?: string): string =>
  page.group === "project"
    ? `/projects/${projectId ?? ""}/settings/${page.slug}`
    : `/settings/${page.slug}`;

/** What decides which pages a person sees: their role in the organization, and the server. */
export interface SettingsViewer {
  readonly role: "owner" | "member";
  readonly operator: boolean;
}

/** Whether this person may open the page. An operator who isn't an owner still sees no owner page. */
export const mayOpen = (page: SettingsPage, viewer: SettingsViewer): boolean => {
  switch (page.access) {
    case "everyone":
      return true;
    case "owners":
      return viewer.role === "owner";
    case "operators":
      return viewer.operator;
  }
};

/** The pages of one group this person sees, in the sidebar's order. */
export const visiblePages = (
  group: SettingsGroup,
  viewer: SettingsViewer,
): ReadonlyArray<SettingsPage> =>
  SETTINGS_PAGES.filter((page) => page.group === group && mayOpen(page, viewer));

/** The page an address shows, with its project for a project's page; null for any other. */
export const pageAt = (
  pathname: string,
): { readonly page: SettingsPage; readonly projectId?: string } | null => {
  const path = pathname.replace(/\/+$/, "");
  // A project's `/projects/<id>/settings` opens its General page on the desk.
  const project = /^\/projects\/([^/]+)\/settings(?:\/([^/]+))?$/.exec(path);
  if (project !== null) {
    const [, projectId, slug = "general"] = project;
    const found = SETTINGS_PAGES.find(
      (candidate) => candidate.group === "project" && candidate.slug === slug,
    );
    return found === undefined || projectId === undefined ? null : { page: found, projectId };
  }
  const found = SETTINGS_PAGES.find(
    (candidate) => candidate.group !== "project" && `/settings/${candidate.slug}` === path,
  );
  return found === undefined ? null : { page: found };
};

/** Whether an address is one of Settings' own: the settings frame replaces the app's sidebar there. */
export const isSettingsPath = (pathname: string): boolean =>
  pathname === "/settings" ||
  pathname.startsWith("/settings/") ||
  /^\/projects\/[^/]+\/settings(\/|$)/.test(pathname);

/** The place a project's name or the organization's fills in the audience line and the breadcrumb. */
export interface SettingsNames {
  readonly organization: string;
  readonly project?: string | undefined;
}

/** The muted line under a page's title (ADR 0025, decision 6). */
export const audienceLine = (audience: SettingsAudience, names: SettingsNames): string => {
  switch (audience) {
    case "you":
      return "Only you";
    case "browser":
      return "Only this browser";
    case "organization":
      return `Everyone in ${names.organization}`;
    case "owners":
      return `Owners of ${names.organization}`;
    case "project":
      return `Everyone who can open ${names.project ?? "this project"}`;
    case "operators":
      return "Operators of this server";
  }
};

/** The group's name, as the sidebar heads it and the breadcrumb's middle crumb says it. */
export const groupName = (group: SettingsGroup, names: SettingsNames): string => {
  switch (group) {
    case "account":
      return "Account";
    case "device":
      return "This device";
    case "organization":
      return names.organization;
    case "project":
      return "Projects";
    case "server":
      return "Server";
  }
};

/** One part of a settings breadcrumb, and where it goes: none for the page itself or a group with no page. */
export interface SettingsCrumb {
  readonly key: "group" | "project" | "page";
  readonly label: string;
  /** The organization's name opens its General page, a project's name the project. */
  readonly opens: "o-general" | "project" | null;
}

/**
 * The breadcrumb above a page, after "Settings": its group, then the page. A project's page names
 * the project in the group's place ("Settings / checkout-api / General"); the Server group has one
 * page, so it isn't said twice. A part that names a page you can go to says which (`opens`):
 * Account and This device are only groups.
 */
export const crumbsOf = (
  page: SettingsPage,
  names: SettingsNames,
): ReadonlyArray<SettingsCrumb> => {
  const last = { key: "page", label: page.label, opens: null } as const;
  if (page.group === "server") return [last];
  if (page.group === "project") {
    return [{ key: "project", label: names.project ?? "Project", opens: "project" }, last];
  }
  const opens = page.group === "organization" && page.id !== "o-general" ? "o-general" : null;
  return [{ key: "group", label: groupName(page.group, names), opens }, last];
};

/**
 * Where each address of the old app's Settings lives now (route PRs 37 to 58). Slack's messages,
 * Executor and the docs hand out some of these, so they keep working; a page not built yet lands on
 * its own future address.
 */
const OLD_PATHS: Readonly<Record<string, string>> = {
  "/settings/account": "/settings/profile",
  "/settings/sessions": "/settings/automation",
  "/settings/review": "/settings/automation",
  "/settings/landing": "/settings/automation",
  "/settings/git-access": "/settings/agent-logins",
  "/settings/access-keys": "/settings/devices",
  // Executor sends a person here after linking their own account (mend-run), so it opens the page
  // that shows that link.
  "/settings/workspace": "/settings/connected-apps",
  "/settings/sealant": "/settings/server",
  "/settings/instance": "/settings/server",
  "/settings/instance/environment": "/settings/server",
  "/settings/instance/defaults": "/settings/server",
  "/settings/instance/exposure": "/settings/server",
  // The old Defaults page held only where new sessions run once automation became each person's.
  "/settings/organization/defaults": "/settings/organization/runtime",
  "/settings/organization/invitations": "/settings/organization/members",
  "/settings/organization/environment": "/settings/organization/workspace-image",
  "/settings/organization/slack": "/settings/organization/integrations",
  "/settings/organization/executor": "/settings/organization/integrations",
};

/**
 * The old Workspace page's sections, by the anchors links to it carry (`/settings#secret-files`
 * went to `/settings/workspace#secret-files`): each lands on the page that holds it now. With no
 * anchor, `/settings/workspace` goes to Connected apps, where Executor sends a person after linking.
 */
const OLD_WORKSPACE_SECTIONS: Readonly<Record<string, string>> = {
  "dotfiles-repo-url": "/settings/dotfiles",
  "dotfiles-manager-label": "/settings/dotfiles",
  "home-files": "/settings/dotfiles",
  "secret-files": "/settings/dotfiles",
  "workspace-ssh": "/settings/devices",
  doppler: "/settings/connected-apps",
};

/** Where `/settings/workspace` with this anchor goes. */
export const oldWorkspacePath = (hash: string): string =>
  OLD_WORKSPACE_SECTIONS[hash.replace(/^#/, "")] ?? "/settings/connected-apps";

/** The new home of an old settings address, or null when the address isn't an old one. */
export const oldSettingsPath = (pathname: string): string | null => {
  const path = pathname.replace(/\/+$/, "");
  return OLD_PATHS[path] ?? null;
};

/**
 * Where an anchor of the old single settings page (`/settings#devices`, from Slack messages and
 * older links) lands now: every section id that page had, and the field ids a link could point
 * into (the old app's `LEGACY_ANCHORS`), each at the page that holds that setting now.
 */
const OLD_ANCHORS: Readonly<Record<string, string>> = {
  accounts: "/settings/agent-logins",
  "dotfiles-repo-url": "/settings/dotfiles",
  "dotfiles-manager-label": "/settings/dotfiles",
  "secret-files": "/settings/dotfiles",
  doppler: "/settings/connected-apps",
  "workspace-ssh": "/settings/devices",
  "git-access": "/settings/agent-logins",
  "git-author": "/settings/agent-logins",
  landing: "/settings/automation",
  devices: "/settings/devices",
  executor: "/settings/connected-apps",
  members: "/settings/organization/members",
  invitations: "/settings/organization/members",
  "organization-defaults": "/settings/organization/runtime",
  "organization-environment": "/settings/organization/workspace-image",
  slack: "/settings/organization/integrations",
  "slack-remove": "/settings/organization/integrations",
  folders: "/settings/organization/folders",
  "departed-projects": "/settings/organization/projects",
  "resource-archives": "/settings/organization/projects",
  audit: "/settings/organization/audit-log",
};

/** The page an old anchor opens, or null for no anchor or one the old page never had. */
export const oldAnchorPath = (hash: string): string | null =>
  OLD_ANCHORS[hash.replace(/^#/, "")] ?? null;

/** Where a section of a project's old settings lives now, given the project. */
type ProjectHome =
  | { readonly page: SettingsPageId }
  | { readonly tab: "skills" | "resources" }
  | { readonly path: string };

/**
 * Every section id the old app's project Configuration page carried (`/projects/<id>/configuration#…`),
 * and the old project settings sections (`/projects/<id>/settings/git`), each at the page that holds
 * that setting now (docs/adr/0025). A project's own automation, its landing policy and its Git access
 * mode are gone: those anchors open the person's own page, where the setting lives now. A page not
 * built yet opens its own address.
 */
const OLD_PROJECT_ANCHORS: Readonly<Record<string, ProjectHome>> = {
  visibility: { page: "p-general" },
  remove: { page: "p-general" },
  links: { page: "p-general" },
  environment: { page: "p-workspace" },
  "hot-sessions": { page: "p-workspace" },
  "install-command": { page: "p-workspace" },
  services: { page: "p-services" },
  variables: { page: "p-secrets" },
  secrets: { page: "p-secrets" },
  "cluster-bindings": { page: "p-secrets" },
  folders: { page: "p-folders" },
  mounts: { page: "p-folders" },
  references: { page: "p-folders" },
  dotfiles: { path: "/settings/dotfiles" },
  git: { path: "/settings/agent-logins" },
  "git-access": { path: "/settings/agent-logins" },
  sessions: { path: "/settings/automation" },
  landing: { path: "/settings/automation" },
  review: { path: "/settings/automation" },
  skills: { tab: "skills" },
  resources: { tab: "resources" },
};

const projectHomePath = (projectId: string, home: ProjectHome): string =>
  "page" in home
    ? settingsPathOf(settingsPage(home.page), projectId)
    : "tab" in home
      ? `/projects/${projectId}/${home.tab}`
      : home.path;

/**
 * Where an old `/projects/<id>/configuration#<anchor>` lands now. No anchor, or one the old page
 * never had, opens the project's General page.
 */
export const oldProjectAnchorPath = (projectId: string, hash: string): string =>
  projectHomePath(projectId, OLD_PROJECT_ANCHORS[hash.replace(/^#/, "")] ?? { page: "p-general" });

/**
 * Where an old project settings section that has no page of its own now
 * (`/projects/<id>/settings/git`, `…/landing`, `…/review`) lands; null for any other address.
 */
export const oldProjectSettingsPath = (pathname: string): string | null => {
  const match = /^\/projects\/([^/]+)\/settings\/([^/]+)\/?$/.exec(pathname);
  if (match === null) return null;
  const [, projectId, section] = match;
  if (projectId === undefined || section === undefined) return null;
  if (SETTINGS_PAGES.some((page) => page.group === "project" && page.slug === section)) return null;
  const home = OLD_PROJECT_ANCHORS[section];
  return home === undefined ? null : projectHomePath(projectId, home);
};
