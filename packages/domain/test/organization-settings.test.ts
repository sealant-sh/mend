import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  inheritedOrganizationSettings,
  MendSettings,
  organizationDefaultSources,
  organizationDefaults,
  OrganizationSettings,
} from "../src/settings.ts";
import { resolveAutoLand } from "../src/workbench/landing.ts";
import { resolveAutomation } from "../src/workbench/project.ts";

const instance = new MendSettings({
  ...defaultSettings,
  autoTour: true,
  autoSuggest: true,
  autoName: true,
  autoLand: false,
  backgroundSessions: true,
});

const fedora = {
  mode: "family" as const,
  os: "fedora" as const,
  packages: ["jq"],
  shell: "zsh" as const,
  services: { docker: false },
};

describe("organization defaults: project → organization → instance", () => {
  it("is the instance when the caller has no organization or the organization set nothing", () => {
    expect(organizationDefaults(instance, null)).toBe(instance);
    expect(organizationDefaults(instance, inheritedOrganizationSettings)).toEqual(instance);
    expect(organizationDefaultSources(null).autoLand).toBe("instance");
    expect(Object.values(organizationDefaultSources(inheritedOrganizationSettings))).toEqual(
      Array.from({ length: 6 }, () => "instance"),
    );
  });

  it("takes each value the organization set and leaves the rest to the instance", () => {
    const organization = new OrganizationSettings({
      ...inheritedOrganizationSettings,
      workspaceImage: fedora,
      autoLand: true,
      autoSuggest: false,
    });
    const resolved = organizationDefaults(instance, organization);
    expect(resolved.workspaceImage).toEqual(fedora);
    expect(resolved.autoLand).toBe(true);
    expect(resolved.autoSuggest).toBe(false);
    expect(resolved.autoTour).toBe(true);
    expect(resolved.autoName).toBe(true);
    expect(resolved.backgroundSessions).toBe(true);
    // Queue-era values are the instance's alone.
    expect(resolved.prMode).toBe(instance.prMode);
    expect(resolved.concurrency).toBe(instance.concurrency);
    expect(organizationDefaultSources(organization)).toEqual({
      workspaceImage: "organization",
      autoTour: "instance",
      autoSuggest: "organization",
      autoName: "instance",
      autoLand: "organization",
      backgroundSessions: "instance",
    });
  });

  it("keeps an organization's off as off, not as a missing value", () => {
    const organization = new OrganizationSettings({
      ...inheritedOrganizationSettings,
      autoName: false,
      backgroundSessions: false,
    });
    const resolved = organizationDefaults(instance, organization);
    expect(resolved.autoName).toBe(false);
    expect(resolved.backgroundSessions).toBe(false);
  });

  it("lets a project's own choice win over the organization, and inherit follow it", () => {
    const defaults = organizationDefaults(
      instance,
      new OrganizationSettings({ ...inheritedOrganizationSettings, autoTour: false }),
    );
    expect(resolveAutomation("inherit", defaults.autoTour)).toBe(false);
    expect(resolveAutomation("on", defaults.autoTour)).toBe(true);

    const landing = organizationDefaults(
      instance,
      new OrganizationSettings({ ...inheritedOrganizationSettings, autoLand: true }),
    );
    const land = (project: "inherit" | "on" | "off") =>
      resolveAutoLand({
        origin: "mend",
        project,
        settings: landing.autoLand,
        session: null,
        slack: false,
      });
    expect(land("inherit")).toBe(true);
    expect(land("off")).toBe(false);
  });

  it("round-trips through its encoded form, nulls included", () => {
    const organization = new OrganizationSettings({
      ...inheritedOrganizationSettings,
      workspaceImage: fedora,
      autoLand: false,
    });
    const encoded = Schema.encodeSync(OrganizationSettings)(organization);
    expect(encoded.autoTour).toBeNull();
    expect(Schema.decodeUnknownSync(OrganizationSettings)(encoded)).toEqual(organization);
  });
});
