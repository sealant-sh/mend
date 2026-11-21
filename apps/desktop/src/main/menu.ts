import type { MenuItemConstructorOptions } from "electron";

import type { DesktopMenuAction, DesktopPlatform } from "../shared/bridge.ts";

/**
 * Application menu builder.
 *
 * Key desktop ergonomics:
 * - `Cmd/Ctrl+W` closes DevTools when DevTools has focus, otherwise dispatches `"close-tab"` to
 *   the web app so closing a workspace tab never kills the desktop window. Closing the window uses
 *   `Shift+Cmd/Ctrl+W` (and the OS close button).
 * - Reload, Force Reload, DevTools, and Zoom explicitly target the main window's `webContents`
 *   instead of Electron's built-in roles, which would target a focused Preview iframe instead.
 * - The Window menu spells out its items explicitly so Electron doesn't inject a `Ctrl+W` close
 *   shortcut on Linux/Windows.
 */

export type MainZoomCommand = "in" | "out" | "reset";
export type MainContentsCommand = "reload" | "force-reload" | "toggle-devtools";

export interface ApplicationMenuHandlers {
  readonly platform: DesktopPlatform;
  readonly appName: string;
  readonly onMenuAction: (action: DesktopMenuAction) => void;
  readonly onCloseWindow: () => void;
  readonly onCloseTabOrDevTools: () => void;
  readonly onMainContentsCommand: (command: MainContentsCommand) => void;
  readonly onZoom: (command: MainZoomCommand) => void;
}

export const buildApplicationMenuTemplate = (
  handlers: ApplicationMenuHandlers,
): Array<MenuItemConstructorOptions> => {
  const isMac = handlers.platform === "darwin";
  const template: Array<MenuItemConstructorOptions> = [];

  if (isMac) {
    template.push({
      label: handlers.appName,
      submenu: [
        { role: "about", label: `About ${handlers.appName}` },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => handlers.onMenuAction("open-settings"),
        },
        {
          label: "Switch Server…",
          accelerator: "Shift+CmdOrCtrl+O",
          click: () => handlers.onMenuAction("switch-server"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${handlers.appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${handlers.appName}` },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => handlers.onMenuAction("new-session"),
        },
        ...(!isMac
          ? [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => handlers.onMenuAction("open-settings"),
              },
              {
                label: "Switch Server…",
                accelerator: "Shift+CmdOrCtrl+O",
                click: () => handlers.onMenuAction("switch-server"),
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => handlers.onCloseTabOrDevTools(),
        },
        {
          label: "Close Window",
          accelerator: "Shift+CmdOrCtrl+W",
          click: () => handlers.onCloseWindow(),
        },
        ...(!isMac ? [{ type: "separator" as const }, { role: "quit" as const }] : []),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => handlers.onMainContentsCommand("reload"),
        },
        {
          label: "Force Reload",
          accelerator: "Shift+CmdOrCtrl+R",
          click: () => handlers.onMainContentsCommand("force-reload"),
        },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: () => handlers.onMainContentsCommand("toggle-devtools"),
        },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: () => handlers.onZoom("reset"),
        },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+num0",
          visible: false,
          click: () => handlers.onZoom("reset"),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: () => handlers.onZoom("in"),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          visible: false,
          click: () => handlers.onZoom("in"),
        },
        ...(isMac
          ? [
              {
                label: "Zoom In",
                accelerator: "CmdOrCtrl+Shift+=",
                visible: false,
                click: () => handlers.onZoom("in"),
              },
            ]
          : []),
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+numadd",
          visible: false,
          click: () => handlers.onZoom("in"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => handlers.onZoom("out"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+numsub",
          visible: false,
          click: () => handlers.onZoom("out"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isMac
          ? [{ role: "zoom" as const }, { type: "separator" as const }, { role: "front" as const }]
          : []),
      ],
    },
  );

  return template;
};
