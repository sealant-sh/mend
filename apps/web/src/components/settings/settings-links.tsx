import type { LinkProps } from "@tanstack/react-router";
import {
  BellIcon,
  BlocksIcon,
  Building2Icon,
  CircleUserRoundIcon,
  ContainerIcon,
  FileCodeIcon,
  FolderGit2Icon,
  FolderIcon,
  KeyRoundIcon,
  LayersIcon,
  LinkIcon,
  LockIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
  SailboatIcon,
  ScrollTextIcon,
  ServerCogIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SquareTerminalIcon,
  SunMoonIcon,
  UserRoundIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { laterPage } from "#/lib/later-pages";
import { settingsPage, type SettingsPageId, settingsPathOf } from "#/lib/settings-pages";

/**
 * Where each settings page's entry goes, in the settings sidebar and the phone's Settings tab.
 * A page whose route exists links to it by name; every other page goes through `laterPage()` to
 * its own address, which shows not found inside Settings until its route PR switches its line
 * here (route PRs 38 to 58). A project's page takes the project: its `case` returns
 * `projectPage("/projects/$projectId/settings/<slug>", projectId)`.
 */
export const settingsLink = (id: SettingsPageId, projectId?: string): LinkProps => {
  switch (id) {
    case "a-profile":
      return { to: "/settings/profile" };
    case "a-logins":
      return { to: "/settings/agent-logins" };
    case "a-mcp":
      return { to: "/settings/mcp-servers" };
    case "a-notifications":
      return { to: "/settings/notifications" };
    case "a-automation":
      return { to: "/settings/automation" };
    case "a-apps":
      return { to: "/settings/connected-apps" };
    case "a-devices":
      return { to: "/settings/devices" };
    case "a-dotfiles":
      return { to: "/settings/dotfiles" };
    case "d-appearance":
      return { to: "/settings/appearance" };
    case "o-boat":
      return { to: "/settings/organization/boat" };
    case "o-projects":
      return { to: "/settings/organization/projects" };
    case "o-audit":
      return { to: "/settings/organization/audit-log" };
    case "o-general":
      return { to: "/settings/organization" };
    case "o-members":
      return { to: "/settings/organization/members" };
    case "s-server":
      return { to: "/settings/server" };
    case "p-general":
      return projectPage("/projects/$projectId/settings/general", id, projectId);
    case "p-folders":
      return projectPage("/projects/$projectId/settings/folders", id, projectId);
    default:
      return laterPage(settingsPathOf(settingsPage(id), projectId).slice(1));
  }
};

/**
 * A project's page by its route, once its project is known; without one (a link drawn before the
 * project is read), the page's own address through `laterPage()`.
 */
const projectPage = (
  to: Extract<NonNullable<LinkProps["to"]>, `/projects/$projectId/settings/${string}`>,
  id: SettingsPageId,
  projectId: string | undefined,
): LinkProps =>
  projectId === undefined
    ? laterPage(settingsPathOf(settingsPage(id)).slice(1))
    : { to, params: { projectId } };

/**
 * Each page's icon, as the canvas's sidebar draws it. A project's pages show theirs only in the
 * phone's list of the project's pages (Doop "Phone · Settings · Project · checkout-api"); the desk's
 * sidebar lists them under the project without one.
 */
export const SETTINGS_ICONS: Partial<Record<SettingsPageId, ReactNode>> = {
  "a-profile": <CircleUserRoundIcon />,
  "a-logins": <KeyRoundIcon />,
  "a-devices": <MonitorSmartphoneIcon />,
  "a-dotfiles": <FileCodeIcon />,
  "a-mcp": <PlugIcon />,
  "a-notifications": <BellIcon />,
  "a-automation": <WorkflowIcon />,
  "a-apps": <LinkIcon />,
  "d-appearance": <SunMoonIcon />,
  "o-general": <Building2Icon />,
  "o-members": <UsersIcon />,
  "o-image": <LayersIcon />,
  "o-runtime": <ContainerIcon />,
  "o-boat": <SailboatIcon />,
  "o-integrations": <BlocksIcon />,
  "o-folders": <FolderIcon />,
  "o-projects": <FolderGit2Icon />,
  "o-audit": <ScrollTextIcon />,
  "p-general": <SlidersHorizontalIcon />,
  "p-workspace": <SquareTerminalIcon />,
  "p-services": <ServerCogIcon />,
  "p-secrets": <LockIcon />,
  "p-folders": <FolderIcon />,
  "p-only-you": <UserRoundIcon />,
  "s-server": <ServerIcon />,
};
