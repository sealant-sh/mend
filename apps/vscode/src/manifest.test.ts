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

const entriesOf = (command: string): ReadonlyArray<MenuEntry> =>
  sessionContextMenu().filter(
    (entry) => entry.command === command && (entry.when ?? "").includes("mend\\.session"),
  );

describe("the session row", () => {
  it("offers Open inline and in its right-click menu", () => {
    const groups = entriesOf("mend.open").map((entry) => entry.group ?? "");
    expect(groups.some((group) => group.startsWith("inline"))).toBe(true);
    // The right-click menu lists every group but `inline`.
    expect(groups.some((group) => !group.startsWith("inline"))).toBe(true);
  });

  it("offers Open in New Window only in its right-click menu", () => {
    const groups = entriesOf("mend.openInNewWindow").map((entry) => entry.group ?? "");
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((group) => !group.startsWith("inline"))).toBe(true);
  });

  it("has no takeover and no Open in VS Code", () => {
    const commands = sessionContextMenu().map((entry) => entry.command);
    expect(commands).not.toContain("mend.takeOverSession");
    expect(commands).not.toContain("mend.openWorktree");
  });
});

describe("bring my editor", () => {
  const setting: unknown = Reflect.get(
    Reflect.get(
      Reflect.get(Reflect.get(manifest ?? {}, "contributes") ?? {}, "configuration") ?? {},
      "properties",
    ) ?? {},
    "mend.workspaces.bringMyEditor",
  );

  it("is a person's own setting, which a repository cannot turn on", () => {
    expect(setting).toMatchObject({
      enum: ["off", "extensions", "extensionsAndSettings"],
      default: "extensionsAndSettings",
      scope: "application",
    });
  });
});
