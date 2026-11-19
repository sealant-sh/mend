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
  MonitorSmartphoneIcon,
  PlugIcon,
  SailboatIcon,
  ScrollTextIcon,
  ServerIcon,
  SunMoonIcon,
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
 * here (route PRs 38 to 58).
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
    case "o-folders":
      return { to: "/settings/organization/folders" };
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
    default:
      return laterPage(settingsPathOf(settingsPage(id), projectId).slice(1));
  }
};

/** Each page's icon, as the canvas's sidebar draws it. A project's pages have none. */
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
  "s-server": <ServerIcon />,
};
