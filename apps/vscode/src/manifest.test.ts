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

const contributed = (key: string): unknown =>
  typeof manifest === "object" && manifest !== null
    ? Reflect.get(Reflect.get(manifest, "contributes") ?? {}, key)
    : undefined;

const itemContextMenu = (): ReadonlyArray<MenuEntry> => {
  const menus = contributed("menus");
  const entries: unknown =
    typeof menus === "object" && menus !== null
      ? Reflect.get(menus, "view/item/context")
      : undefined;
  return Array.isArray(entries) ? entries.filter(isMenuEntry) : [];
};

/**
 * Whether a `when` clause holds for a row of the Mend view, for the clause shapes the manifest
 * uses: `view == …`, `viewItem == …` and `viewItem =~ /…/`, joined by `&&`.
 */
const holds = (when: string, viewItem: string): boolean =>
  when.split("&&").every((clause) => {
    const [key = "", operator = "", ...rest] = clause.trim().split(" ");
    const value = rest.join(" ");
    const subject = key === "view" ? "mend.sessions" : key === "viewItem" ? viewItem : null;
    if (subject === null) throw new Error(`the test cannot read the clause "${clause}"`);
    if (operator === "==") return subject === value;
    const pattern = /^\/(.*)\/$/.exec(value)?.[1];
    if (operator === "=~" && pattern !== undefined) return new RegExp(pattern).test(subject);
    throw new Error(`the test cannot read the clause "${clause}"`);
  });

/** Where a row of this `viewItem` shows `command`: its groups, `inline…` being the row's buttons. */
const groupsOn = (command: string, viewItem: string): ReadonlyArray<string> =>
  itemContextMenu()
    .filter((entry) => entry.command === command && holds(entry.when ?? "", viewItem))
    .map((entry) => entry.group ?? "");

const inline = (groups: ReadonlyArray<string>) =>
  groups.filter((group) => group.startsWith("inline"));
// The right-click menu lists every group but `inline`.
const contextMenu = (groups: ReadonlyArray<string>) =>
  groups.filter((group) => !group.startsWith("inline"));

const OPEN_ROWS = ["mend.session.live.open", "mend.session.settled.open"];
const NOT_YOURS_ROWS = [
  "mend.session.live.watch",
  "mend.session.settled.watch",
  "mend.session.live.review",
  "mend.session.settled.review",
];

describe("a session row the viewer can open", () => {
  it.each(OPEN_ROWS)("%s offers Open as its button and in its right-click menu", (row) => {
    expect(inline(groupsOn("mend.open", row))).toEqual(["inline@1"]);
    expect(contextMenu(groupsOn("mend.open", row))).toEqual(["1_open@0"]);
  });

  it.each(OPEN_ROWS)("%s offers Open in New Window only in its right-click menu", (row) => {
    expect(groupsOn("mend.openInNewWindow", row)).toEqual(["1_open@1"]);
  });

  it("offers the terminal only while the session is live", () => {
    expect(groupsOn("mend.openTerminal", "mend.session.live.open")).toEqual(["1_open@2"]);
    expect(groupsOn("mend.openTerminal", "mend.session.settled.open")).toEqual([]);
  });
});

describe("a session row whose workspace someone else launched", () => {
  it.each(NOT_YOURS_ROWS)("%s offers no Open, and Review as a button", (row) => {
    expect(groupsOn("mend.open", row)).toEqual([]);
    expect(groupsOn("mend.openInNewWindow", row)).toEqual([]);
    expect(groupsOn("mend.newSessionInWorktree", row)).toEqual([]);
    expect(inline(groupsOn("mend.reviewChange", row))).toEqual(["inline@2"]);
  });

  it("offers Watch terminal as a button while the session is live and shared", () => {
    expect(inline(groupsOn("mend.watchTerminal", "mend.session.live.watch"))).toEqual(["inline@1"]);
    expect(groupsOn("mend.watchTerminal", "mend.session.live.review")).toEqual([]);
    expect(groupsOn("mend.openTerminal", "mend.session.live.watch")).toEqual([]);
  });
});

describe("the commands", () => {
  it("have no takeover and no Open in VS Code", () => {
    const commands = contributed("commands");
    const ids = (Array.isArray(commands) ? commands.filter(isMenuEntry) : []).map(
      (entry) => entry.command,
    );
    expect(ids).toEqual(expect.arrayContaining(["mend.open", "mend.openInNewWindow"]));
    expect(ids).not.toContain("mend.takeOverSession");
    expect(ids).not.toContain("mend.openWorktree");
    const menuCommands = itemContextMenu().map((entry) => entry.command);
    expect(menuCommands).not.toContain("mend.takeOverSession");
    expect(menuCommands).not.toContain("mend.openWorktree");
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
