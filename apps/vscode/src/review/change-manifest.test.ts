import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

interface MenuEntry {
  readonly command: string;
  readonly when?: string;
  readonly group?: string;
}

const manifest: unknown = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
);

const contributed = (key: string): unknown =>
  typeof manifest === "object" && manifest !== null
    ? Reflect.get(Reflect.get(manifest, "contributes") ?? {}, key)
    : undefined;

const isMenuEntry = (value: unknown): value is MenuEntry =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "command") === "string";

const menu = (name: string): ReadonlyArray<MenuEntry> => {
  const menus = contributed("menus");
  const entries: unknown =
    typeof menus === "object" && menus !== null ? Reflect.get(menus, name) : undefined;
  return Array.isArray(entries) ? entries.filter(isMenuEntry) : [];
};

const onChangeTitle = (command: string): ReadonlyArray<string> =>
  menu("view/title")
    .filter((entry) => entry.command === command && entry.when?.includes("view == mend.change"))
    .map((entry) => entry.group ?? "");

describe("the Change section (story d)", () => {
  it("is a view of its own in the Mend container, under Sessions", () => {
    const views = contributed("views");
    const mend: unknown =
      typeof views === "object" && views !== null ? Reflect.get(views, "mend") : [];
    const ids = Array.isArray(mend)
      ? mend.map((view: unknown) => Reflect.get(Object(view), "id"))
      : [];
    expect(ids).toEqual(["mend.sessions", "mend.change"]);
  });

  it("offers Open all changes as a title button", () => {
    expect(onChangeTitle("mend.change.openAll")).toEqual(["navigation@2"]);
  });

  it("opens the web app only from its overflow menu (rule 11)", () => {
    const groups = onChangeTitle("mend.change.openInWeb");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.startsWith("navigation")).toBe(false);
  });
});
