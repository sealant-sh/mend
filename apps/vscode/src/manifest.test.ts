import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

interface MenuEntry {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

const manifest: unknown = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

const isMenuEntry = (value: unknown): value is MenuEntry =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "command") === "string";

const sessionContextMenu = (): ReadonlyArray<MenuEntry> => {
  const menus: unknown =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(Reflect.get(manifest, "contributes") ?? {}, "menus")
      : undefined;
  const entries: unknown =
    typeof menus === "object" && menus !== null
      ? Reflect.get(menus, "view/item/context")
      : undefined;
  return Array.isArray(entries) ? entries.filter(isMenuEntry) : [];
};

describe("the session row", () => {
  it("offers Open in VS Code inline and in its right-click menu", () => {
    const openOnSession = sessionContextMenu().filter(
      (entry) =>
        entry.command === "mend.openWorktree" && (entry.when ?? "").includes("mend\\.session"),
    );
    const groups = openOnSession.map((entry) => entry.group ?? "");
    expect(groups.some((group) => group.startsWith("inline"))).toBe(true);
    // The right-click menu lists every group but `inline`.
    expect(groups.some((group) => !group.startsWith("inline"))).toBe(true);
  });
});
