import { describe, expect, it } from "vitest";

import { legacyAnchorTarget, SETTINGS_TABS } from "./settings-tabs.ts";

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
