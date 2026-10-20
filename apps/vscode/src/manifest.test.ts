import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mayStop, rowCapability, rowContextValue } from "./session-capability.js";
import type { Session } from "./types.js";

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

const OPEN_ROWS = [
  "mend.session.live.open.steer",
  "mend.session.settled.open.steer",
  "mend.session.live.open",
  "mend.session.settled.open",
];
const NOT_YOURS_ROWS = [
  "mend.session.live.watch.steer",
  "mend.session.settled.watch.steer",
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

  it("offers the terminal only while the session is live and hers to steer", () => {
    expect(groupsOn("mend.openTerminal", "mend.session.live.open.steer")).toEqual(["1_open@2"]);
    expect(groupsOn("mend.openTerminal", "mend.session.live.open")).toEqual([]);
    expect(groupsOn("mend.openTerminal", "mend.session.settled.open.steer")).toEqual([]);
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
    expect(inline(groupsOn("mend.watchTerminal", "mend.session.live.watch.steer"))).toEqual([
      "inline@1",
    ]);
    expect(groupsOn("mend.watchTerminal", "mend.session.live.review")).toEqual([]);
    expect(groupsOn("mend.openTerminal", "mend.session.live.watch.steer")).toEqual([]);
  });
});

type Row = Pick<
  Session,
  "ownerUserId" | "sharedControlEnabledAt" | "workspaceLauncherUserId" | "livePeople" | "status"
>;

/** The `viewItem` the tree gives a row of this session for this viewer. */
const row = (session: Row, viewer: string | null) =>
  rowContextValue(
    session,
    rowCapability({ session, viewer, members: [] }),
    mayStop(session, viewer),
  );

describe("a session row as the code labels it", () => {
  const ana: Row = {
    ownerUserId: "ana",
    sharedControlEnabledAt: null,
    workspaceLauncherUserId: "ana",
    livePeople: [],
    status: "running",
  };
  it("offers Stop only on a live session the viewer may steer", () => {
    expect(groupsOn("mend.stopSession", row(ana, "ana"))).toEqual(["2_session@1"]);
    expect(groupsOn("mend.stopSession", row(ana, "dana"))).toEqual([]);
    expect(
      groupsOn("mend.stopSession", row({ ...ana, workspaceLauncherUserId: null }, "dana")),
    ).toEqual([]);
    expect(
      groupsOn(
        "mend.stopSession",
        row({ ...ana, sharedControlEnabledAt: "2026-10-19T09:00:00.000Z" }, "dana"),
      ),
    ).toEqual(["2_session@1"]);
    expect(groupsOn("mend.stopSession", row({ ...ana, status: "stopped" }, "ana"))).toEqual([]);
  });

  it("offers no Open and no Stop when Mend could not read who the viewer is", () => {
    const unknown = row(ana, null);
    expect(groupsOn("mend.open", unknown)).toEqual([]);
    expect(groupsOn("mend.openInNewWindow", unknown)).toEqual([]);
    expect(groupsOn("mend.stopSession", unknown)).toEqual([]);
    expect(inline(groupsOn("mend.reviewChange", unknown))).toEqual(["inline@2"]);
  });
});

describe("a row that needs her (story b)", () => {
  it("offers Answer as its first button and keeps what the row offers beside it", () => {
    expect(inline(groupsOn("mend.answer", "mend.session.live.open.steer.needs"))).toEqual([
      "inline@0",
    ]);
    expect(inline(groupsOn("mend.open", "mend.session.live.open.steer.needs"))).toEqual([
      "inline@1",
    ]);
    expect(inline(groupsOn("mend.watchTerminal", "mend.session.live.watch.steer.needs"))).toEqual([
      "inline@1",
    ]);
    expect(groupsOn("mend.answer", "mend.session.live.open")).toEqual([]);
    expect(groupsOn("mend.stopSession", "mend.session.live.open.steer.needs")).toEqual([
      "2_session@1",
    ]);
    expect(groupsOn("mend.stopSession", "mend.session.live.review.needs")).toEqual([]);
  });
});

const commandEntries = (): ReadonlyArray<Record<string, unknown>> => {
  const commands = contributed("commands");
  return Array.isArray(commands)
    ? commands.filter((entry): entry is Record<string, unknown> => isMenuEntry(entry))
    : [];
};

describe("offline (stories a and b)", () => {
  it.each(["mend.newSession", "mend.answer"])("%s is disabled while Mend is offline", (id) => {
    expect(commandEntries().find((entry) => entry.command === id)?.enablement).toBe(
      "!mend.offline",
    );
  });
});

const menu = (key: string): ReadonlyArray<MenuEntry> => {
  const menus = contributed("menus");
  const entries: unknown =
    typeof menus === "object" && menus !== null ? Reflect.get(menus, key) : undefined;
  return Array.isArray(entries) ? entries.filter(isMenuEntry) : [];
};

describe("New session (story a)", () => {
  it("is titled in the stories' words", () => {
    expect(commandEntries().find((entry) => entry.command === "mend.newSession")?.title).toBe(
      "Mend: New session",
    );
  });

  it("has an offline twin in the view's title bar: disabled, and its tooltip says why", () => {
    expect(commandEntries().find((entry) => entry.command === "mend.newSessionOffline")).toEqual({
      command: "mend.newSessionOffline",
      title: "Mend is offline · retrying",
      icon: "$(add)",
      enablement: "false",
    });
    const title = menu("view/title");
    expect(title.find((entry) => entry.command === "mend.newSession")).toMatchObject({
      when: "view == mend.sessions && !mend.offline",
      group: "navigation@1",
    });
    expect(title.find((entry) => entry.command === "mend.newSessionOffline")).toMatchObject({
      when: "view == mend.sessions && mend.offline",
      group: "navigation@1",
    });
    expect(menu("commandPalette")).toContainEqual({
      command: "mend.newSessionOffline",
      when: "false",
    });
  });

  it("has no New worktree without an agent: a shell from Change… covers it", () => {
    expect(commandEntries().map((entry) => entry.command)).not.toContain("mend.newManualWorktree");
    expect(itemContextMenu().map((entry) => entry.command)).not.toContain("mend.newManualWorktree");
  });

  it("keeps New session in this worktree on a row she can open", () => {
    expect(groupsOn("mend.newSessionInWorktree", "mend.session.live.open.steer")).toEqual([
      "1_open@3",
    ]);
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
