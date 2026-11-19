import { describe, expect, it } from "vitest";

import { laterSettingsTarget, SETTINGS_HOME } from "./settings-guards.ts";
import {
  audienceLine,
  crumbsOf,
  isSettingsPath,
  mayOpen,
  oldAnchorPath,
  oldProjectAnchorPath,
  oldProjectSettingsPath,
  oldSettingsPath,
  pageAt,
  SETTINGS_PAGES,
  settingsPage,
  settingsPathOf,
  type SettingsViewer,
  visiblePages,
} from "./settings-pages.ts";

const owner: SettingsViewer = { role: "owner", operator: false };
const member: SettingsViewer = { role: "member", operator: false };
const operator: SettingsViewer = { role: "member", operator: true };

const labels = (viewer: SettingsViewer) =>
  (["account", "device", "organization", "project", "server"] as const).flatMap((group) =>
    visiblePages(group, viewer).map((page) => page.id),
  );

describe("who sees which settings pages", () => {
  it("lists every page for an owner except the Server", () => {
    expect(labels(owner)).toHaveLength(SETTINGS_PAGES.length - 1);
    expect(labels(owner)).not.toContain("s-server");
  });

  it("hides the organization's Projects and Audit log from a member", () => {
    expect(labels(member)).not.toContain("o-projects");
    expect(labels(member)).not.toContain("o-audit");
    expect(labels(member)).toContain("o-members");
  });

  it("shows an operator who isn't an owner the Server, and still no owner page", () => {
    expect(labels(operator)).toContain("s-server");
    expect(labels(operator)).not.toContain("o-projects");
    expect(labels(operator)).not.toContain("o-audit");
  });

  it("shows an owner who runs the server everything", () => {
    expect(labels({ role: "owner", operator: true })).toHaveLength(SETTINGS_PAGES.length);
  });

  it("names the 25 pages of the canvas's settings sidebar, in its order", () => {
    expect(SETTINGS_PAGES.map((page) => page.id)).toEqual([
      "a-profile",
      "a-logins",
      "a-devices",
      "a-dotfiles",
      "a-mcp",
      "a-notifications",
      "a-automation",
      "a-apps",
      "d-appearance",
      "o-general",
      "o-members",
      "o-image",
      "o-runtime",
      "o-boat",
      "o-integrations",
      "o-folders",
      "o-projects",
      "o-audit",
      "p-general",
      "p-workspace",
      "p-services",
      "p-secrets",
      "p-folders",
      "p-only-you",
      "s-server",
    ]);
  });
});

describe("addresses", () => {
  it("puts each page at the address the list of PRs gives it", () => {
    expect(settingsPathOf(settingsPage("a-profile"))).toBe("/settings/profile");
    expect(settingsPathOf(settingsPage("d-appearance"))).toBe("/settings/appearance");
    expect(settingsPathOf(settingsPage("o-general"))).toBe("/settings/organization");
    expect(settingsPathOf(settingsPage("o-image"))).toBe("/settings/organization/workspace-image");
    expect(settingsPathOf(settingsPage("p-secrets"), "p1")).toBe("/projects/p1/settings/secrets");
    expect(settingsPathOf(settingsPage("s-server"))).toBe("/settings/server");
  });

  it("reads every page back from its own address", () => {
    for (const page of SETTINGS_PAGES) {
      expect(pageAt(settingsPathOf(page, "p1"))?.page.id).toBe(page.id);
    }
    expect(pageAt("/projects/p1/settings/general")?.projectId).toBe("p1");
    // A project's settings open on General, as its own address does.
    expect(pageAt("/projects/p1/settings")).toEqual(pageAt("/projects/p1/settings/general"));
    expect(pageAt("/settings/profile/")?.page.id).toBe("a-profile");
    expect(pageAt("/settings")).toBeNull();
    expect(pageAt("/settings/nothing-here")).toBeNull();
  });

  it("knows Settings' own addresses, a project's included", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/appearance")).toBe(true);
    expect(isSettingsPath("/projects/p1/settings/general")).toBe(true);
    expect(isSettingsPath("/projects/p1")).toBe(false);
    expect(isSettingsPath("/settingsx")).toBe(false);
    expect(isSettingsPath("/")).toBe(false);
  });
});

describe("audience line and breadcrumb", () => {
  const names = { organization: "Northwind", project: "checkout-api" };

  it("says who each page reaches", () => {
    expect(audienceLine(settingsPage("a-profile").audience, names)).toBe("Only you");
    expect(audienceLine(settingsPage("d-appearance").audience, names)).toBe("Only this browser");
    expect(audienceLine(settingsPage("o-members").audience, names)).toBe("Everyone in Northwind");
    expect(audienceLine(settingsPage("o-audit").audience, names)).toBe("Owners of Northwind");
    expect(audienceLine(settingsPage("p-general").audience, names)).toBe(
      "Everyone who can open checkout-api",
    );
    expect(audienceLine(settingsPage("p-only-you").audience, names)).toBe("Only you");
    expect(audienceLine(settingsPage("s-server").audience, names)).toBe("Operators of this server");
  });

  it("walks from Settings to the page", () => {
    const crumbs = (id: Parameters<typeof settingsPage>[0]) =>
      crumbsOf(settingsPage(id), names).map((crumb) => crumb.label);
    expect(crumbs("a-profile")).toEqual(["Account", "Profile"]);
    expect(crumbs("d-appearance")).toEqual(["This device", "Appearance"]);
    expect(crumbs("o-general")).toEqual(["Northwind", "General"]);
    expect(crumbs("p-services")).toEqual(["checkout-api", "Services"]);
    expect(crumbs("s-server")).toEqual(["Server"]);
  });
});

describe("old settings addresses", () => {
  it.each([
    ["/settings/account", "/settings/profile"],
    ["/settings/sessions", "/settings/automation"],
    ["/settings/review", "/settings/automation"],
    ["/settings/landing", "/settings/automation"],
    ["/settings/git-access", "/settings/agent-logins"],
    ["/settings/access-keys", "/settings/devices"],
    ["/settings/workspace", "/settings/connected-apps"],
    ["/settings/sealant", "/settings/server"],
    ["/settings/instance/exposure", "/settings/server"],
    ["/settings/organization/defaults", "/settings/organization/runtime"],
    ["/settings/organization/invitations", "/settings/organization/members"],
    ["/settings/organization/environment", "/settings/organization/workspace-image"],
    ["/settings/organization/slack", "/settings/organization/integrations"],
    ["/settings/organization/executor", "/settings/organization/integrations"],
  ])("%s goes to %s", (old, now) => {
    expect(oldSettingsPath(old)).toBe(now);
    expect(pageAt(now)).not.toBeNull();
  });

  it("leaves an address that is already a page's", () => {
    expect(oldSettingsPath("/settings/devices")).toBeNull();
    expect(oldSettingsPath("/settings/organization/members")).toBeNull();
  });

  it.each([
    ["#accounts", "/settings/agent-logins"],
    ["#secret-files", "/settings/dotfiles"],
    ["#doppler", "/settings/connected-apps"],
    ["#workspace-ssh", "/settings/devices"],
    ["#git-author", "/settings/agent-logins"],
    ["#devices", "/settings/devices"],
    ["#executor", "/settings/connected-apps"],
    ["#invitations", "/settings/organization/members"],
    ["#slack", "/settings/organization/integrations"],
    ["#departed-projects", "/settings/organization/projects"],
    ["#audit", "/settings/organization/audit-log"],
  ])("the old page's %s opens %s", (anchor, now) => {
    expect(oldAnchorPath(anchor)).toBe(now);
    expect(pageAt(now)).not.toBeNull();
  });

  // The old app kept where new sessions run on Defaults (`/settings/organization/defaults`, the
  // single page's `#organization-defaults`) and the starting image on Environment
  // (`/settings/organization/environment`, `#organization-environment`), which had no runtime
  // section. Each lands on its one page now, for owners and members alike.
  it("sends the old runtime links to Runtime and the old environment links to Workspace image", () => {
    expect(oldAnchorPath("#organization-defaults")).toBe("/settings/organization/runtime");
    expect(oldAnchorPath("#organization-environment")).toBe(
      "/settings/organization/workspace-image",
    );
    for (const viewer of [owner, member]) {
      expect(laterSettingsTarget("/settings/organization/defaults", viewer)).toBe(
        "/settings/organization/runtime",
      );
      expect(laterSettingsTarget("/settings/organization/environment/", viewer)).toBe(
        "/settings/organization/workspace-image",
      );
    }
  });

  it("stays on Settings for no anchor or one the old page never had", () => {
    expect(oldAnchorPath("")).toBeNull();
    expect(oldAnchorPath("#nothing-here")).toBeNull();
  });
});

describe("a project's old settings addresses", () => {
  it.each([
    ["#visibility", "/projects/p1/settings/general"],
    ["#links", "/projects/p1/settings/general"],
    ["#install-command", "/projects/p1/settings/workspace"],
    ["#services", "/projects/p1/settings/services"],
    ["#cluster-bindings", "/projects/p1/settings/secrets"],
    ["#references", "/projects/p1/settings/folders"],
    ["#skills", "/projects/p1/skills"],
    ["#resources", "/projects/p1/resources"],
    ["#dotfiles", "/settings/dotfiles"],
    ["#git-access", "/settings/agent-logins"],
    ["#landing", "/settings/automation"],
  ])("the Configuration page's %s opens %s", (anchor, now) => {
    expect(oldProjectAnchorPath("p1", anchor)).toBe(now);
  });

  it("opens General for no anchor or one the old page never had", () => {
    expect(oldProjectAnchorPath("p1", "")).toBe("/projects/p1/settings/general");
    expect(oldProjectAnchorPath("p1", "#nothing-here")).toBe("/projects/p1/settings/general");
  });

  it("sends an old settings section with no page of its own to the setting's home", () => {
    expect(oldProjectSettingsPath("/projects/p1/settings/git")).toBe("/settings/agent-logins");
    expect(oldProjectSettingsPath("/projects/p1/settings/review/")).toBe("/settings/automation");
  });

  it("leaves a project page's own address, built or not, and any other address", () => {
    expect(oldProjectSettingsPath("/projects/p1/settings/services")).toBeNull();
    expect(oldProjectSettingsPath("/projects/p1/settings/nothing-here")).toBeNull();
    expect(oldProjectSettingsPath("/settings/git")).toBeNull();
  });
});

describe("a page not built yet, by address", () => {
  it("sends an old address to its new home", () => {
    expect(laterSettingsTarget("/settings/git-access", member)).toBe("/settings/agent-logins");
  });

  it("refuses an owner's page to a member, and the Server to anyone who doesn't run it", () => {
    expect(laterSettingsTarget("/settings/organization/audit-log", member)).toBe(SETTINGS_HOME);
    expect(laterSettingsTarget("/settings/organization/projects", operator)).toBe(SETTINGS_HOME);
    expect(laterSettingsTarget("/settings/server", owner)).toBe(SETTINGS_HOME);
    expect(laterSettingsTarget("/settings/sealant", member)).toBe(SETTINGS_HOME);
  });

  it("lets the person through to a page they may open", () => {
    expect(laterSettingsTarget("/settings/organization/audit-log", owner)).toBeNull();
    expect(laterSettingsTarget("/settings/server", operator)).toBeNull();
    expect(laterSettingsTarget("/settings/nothing-here", member)).toBeNull();
    expect(mayOpen(settingsPage("a-profile"), member)).toBe(true);
  });
});
