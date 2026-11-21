import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";

import { buildApplicationMenuTemplate } from "./menu.ts";

const flatten = (
  items: ReadonlyArray<MenuItemConstructorOptions>,
): Array<MenuItemConstructorOptions> => {
  const result: Array<MenuItemConstructorOptions> = [];
  for (const item of items) {
    result.push(item);
    if (Array.isArray(item.submenu)) {
      result.push(...flatten(item.submenu));
    }
  }
  return result;
};

const noop = () => undefined;

describe("buildApplicationMenuTemplate", () => {
  it("routes Cmd/Ctrl+W to Close Tab instead of Electron's built-in window close role", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const template = buildApplicationMenuTemplate({
        platform,
        appName: "Mend",
        onMenuAction: noop,
        onCloseWindow: noop,
        onCloseTabOrDevTools: noop,
        onMainContentsCommand: noop,
        onZoom: noop,
      });

      const items = flatten(template);
      expect(items.some((item) => item.role === "close")).toBe(false);
      const closeTab = items.find((item) => item.accelerator === "CmdOrCtrl+W");
      expect(closeTab?.label).toBe("Close Tab");
      expect(typeof closeTab?.click).toBe("function");
    }
  });

  it("targets the main window explicitly for reload, DevTools, and zoom instead of built-in guest-targeting roles", () => {
    const template = buildApplicationMenuTemplate({
      platform: "linux",
      appName: "Mend",
      onMenuAction: noop,
      onCloseWindow: noop,
      onCloseTabOrDevTools: noop,
      onMainContentsCommand: noop,
      onZoom: noop,
    });
    const roles = new Set(flatten(template).map((item) => item.role));
    expect(roles.has("reload")).toBe(false);
    expect(roles.has("forceReload")).toBe(false);
    expect(roles.has("toggleDevTools")).toBe(false);
    expect(roles.has("zoomIn")).toBe(false);
    expect(roles.has("zoomOut")).toBe(false);
    expect(roles.has("resetZoom")).toBe(false);
  });
});
