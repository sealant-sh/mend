import { describe, expect, it } from "vitest";

import {
  legacyAnchorRedirect,
  legacyAnchorTarget,
  SETTINGS_TABS,
  visibleTabs,
} from "./settings-tabs.ts";

/** Every section id the single settings page had before the redesign (git 509837c0c2). */
const RETIRED: ReadonlyArray<readonly [string, string]> = [
  ["accounts", "/settings/account"],
  ["doppler", "/settings/workspace"],
  ["secret-files", "/settings/workspace"],
  ["workspace-ssh", "/settings/workspace"],
  ["dotfiles-repo-url", "/settings/workspace"],
  ["git-access", "/settings/git-access"],
  ["git-author", "/settings/git-access"],
  ["landing", "/settings/landing"],
  ["devices", "/settings/devices"],
  ["members", "/settings/organization/members"],
  ["invitations", "/settings/organization/invitations"],
  ["organization-defaults", "/settings/organization/defaults"],
  ["organization-environment", "/settings/organization/environment"],
  ["slack", "/settings/organization/slack"],
  ["slack-remove", "/settings/organization/slack"],
  ["folders", "/settings/organization/folders"],
  ["departed-projects", "/settings/organization/projects"],
  ["resource-archives", "/settings/organization/projects"],
  ["audit", "/settings/organization/audit-log"],
];

describe("old /settings anchors", () => {
  it.each(RETIRED)("#%s opens %s", (anchor, path) => {
    expect(legacyAnchorTarget(`#${anchor}`)).toBe(path);
  });

  it("opens Account for no anchor or one it never had", () => {
    expect(legacyAnchorTarget("")).toBe("/settings/account");
    expect(legacyAnchorTarget("#nothing-here")).toBe("/settings/account");
  });

  it("only ever lands on a tab that exists", () => {
    const paths = new Set(SETTINGS_TABS.map((tab) => tab.to));
    for (const [anchor] of RETIRED) expect(paths.has(legacyAnchorTarget(anchor))).toBe(true);
  });
});

describe("MCP servers", () => {
  it("is a You tab, so a person in no organization keeps their own servers", () => {
    const tab = SETTINGS_TABS.find((candidate) => candidate.to === "/settings/mcp-servers");
    expect(tab?.group).toBe("you");
    expect(visibleTabs("you", { organization: null, operator: false })).toContain(tab);
  });

  it("holds the Executor, which Organization no longer lists, and the old anchor lands on it", () => {
    expect(SETTINGS_TABS.map((tab) => tab.label)).not.toContain("Executor");
    expect(legacyAnchorTarget("#executor")).toBe("/settings/mcp-servers");
  });

  it("keeps the anchor, so /settings#executor opens the Executor row", () => {
    expect(legacyAnchorRedirect("executor")).toEqual({
      to: "/settings/mcp-servers",
      hash: "executor",
    });
    expect(legacyAnchorRedirect("#executor")).toEqual({
      to: "/settings/mcp-servers",
      hash: "executor",
    });
    expect(legacyAnchorRedirect("nothing-here")).toEqual({ to: "/settings/account" });
  });
});
