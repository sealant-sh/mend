import { OrganizationSettingsView, OrganizationView } from "@mend/api-contracts";
import {
  defaultSettings,
  inheritedOrganizationSettings,
  MendSettings,
  OrganizationId,
  organizationDefaults,
  OrganizationSettings,
} from "@mend/domain";
import { Organization, type OrganizationRole } from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { defaultsAccess } from "#/lib/organization-defaults";

import { InstanceDefaults, OrganizationSwitches } from "./organization-defaults.tsx";

const NOW = new Date("2026-09-26T10:00:00Z");
const acme = new Organization({
  id: OrganizationId.make("org-acme"),
  name: "Acme",
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const viewer = (role: OrganizationRole, operator: boolean) =>
  new OrganizationView({
    organization: acme,
    userId: "carol",
    role,
    memberCount: 3,
    operator,
    tenancy: "multi",
    mountDelivery: "bind",
  });

const instanceEditors = (view: OrganizationView | undefined) =>
  renderToStaticMarkup(
    <InstanceDefaults view={view}>
      <p>instance workspace environment editor</p>
    </InstanceDefaults>,
  );

describe("Settings: the instance's defaults are the operator's (docs/adr/0003)", () => {
  it("shows no instance editors to an owner or a member who does not operate the instance", () => {
    expect(instanceEditors(viewer("owner", false))).toBe("");
    expect(instanceEditors(viewer("member", false))).toBe("");
    expect(instanceEditors(undefined)).toBe("");
  });

  it("shows them to the operator, labelled as the instance's", () => {
    const markup = instanceEditors(viewer("owner", true));
    expect(markup).toContain("instance · operator");
    expect(markup).toContain("instance workspace environment editor");
  });

  it("gives owners their organization's editors and members a read-only view", () => {
    expect(defaultsAccess(viewer("owner", false))).toEqual({
      instance: false,
      organization: "edit",
    });
    expect(defaultsAccess(viewer("member", false))).toEqual({
      instance: false,
      organization: "read",
    });
    expect(defaultsAccess(viewer("member", true)).instance).toBe(true);
    expect(defaultsAccess(undefined)).toEqual({ instance: false, organization: null });
  });
});

const instance = new MendSettings({ ...defaultSettings, autoLand: false, autoTour: true });
const own = new OrganizationSettings({ ...inheritedOrganizationSettings, autoLand: true });
const settingsView = (editable: boolean) =>
  new OrganizationSettingsView({
    organization: own,
    instance,
    effective: organizationDefaults(instance, own),
    editable,
  });

const switches = (editable: boolean) =>
  renderToStaticMarkup(
    <OrganizationSwitches
      view={settingsView(editable)}
      organizationName="Acme"
      pending={null}
      error={null}
      onChoose={() => undefined}
    />,
  );

describe("Settings: an organization's defaults", () => {
  it("says they apply to every project in the organization unless the project overrides them", () => {
    expect(switches(true)).toContain(
      "Applies to every project in Acme unless the project overrides it.",
    );
  });

  it("lets an owner choose the instance's value, on or off", () => {
    const markup = switches(true);
    expect(markup).toContain("Instance · off");
    expect(markup).toContain("Instance · on");
    // Land when a turn completes is Acme's own: On is the pressed choice.
    expect(markup).toMatch(/aria-pressed="true"[^>]*>On</);
  });

  it("shows a member each value and where it came from, with nothing to press", () => {
    const markup = switches(false);
    expect(markup).not.toContain("<button");
    expect(markup).toContain("on · Acme");
    expect(markup).toContain("on · instance");
  });
});
