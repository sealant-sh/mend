import { describe, expect, it } from "vitest";

import { OrganizationId } from "../ids.ts";
import {
  canChangeVisibility,
  canManageProject,
  canRemoveProject,
  canSeeProject,
  canUseLink,
  invitationState,
  organizationNameIssue,
  type ProjectTenancy,
  type Viewer,
} from "./organization.ts";

const acme = OrganizationId.make("org-acme");
const globex = OrganizationId.make("org-globex");

const viewer = (userId: string, role: Viewer["role"], organizationId = acme): Viewer => ({
  userId,
  organizationId,
  role,
});

const project = (
  visibility: ProjectTenancy["visibility"],
  createdByUserId: string | null,
  organizationId = acme,
): ProjectTenancy => ({ organizationId, visibility, createdByUserId });

describe("project visibility (docs/adr/0003)", () => {
  const owner = viewer("olga", "owner");
  const creator = viewer("carol", "member");
  const member = viewer("mo", "member");
  const outsider = viewer("bob", "owner", globex);

  it("a shared project is visible to every member of its organization and nobody else", () => {
    const shared = project("shared", "carol");
    expect(canSeeProject(shared, owner)).toBe(true);
    expect(canSeeProject(shared, creator)).toBe(true);
    expect(canSeeProject(shared, member)).toBe(true);
    expect(canSeeProject(shared, outsider)).toBe(false);
  });

  it("a private project is visible to its creator only, owners included", () => {
    const secret = project("private", "carol");
    expect(canSeeProject(secret, creator)).toBe(true);
    expect(canSeeProject(secret, owner)).toBe(false);
    expect(canSeeProject(secret, member)).toBe(false);
    expect(canSeeProject(secret, outsider)).toBe(false);
  });

  it("a private project with no recorded creator is visible to nobody", () => {
    expect(canSeeProject(project("private", null), owner)).toBe(false);
  });

  it("owners and creators manage what they can see; other members do not", () => {
    const shared = project("shared", "carol");
    expect(canManageProject(shared, owner)).toBe(true);
    expect(canManageProject(shared, creator)).toBe(true);
    expect(canManageProject(shared, member)).toBe(false);
    expect(canManageProject(shared, outsider)).toBe(false);
    expect(canManageProject(project("private", "carol"), owner)).toBe(false);
  });

  it("only an owner changes visibility, and only of a project they can see", () => {
    expect(canChangeVisibility(project("shared", "carol"), owner)).toBe(true);
    expect(canChangeVisibility(project("shared", "carol"), creator)).toBe(false);
    expect(canChangeVisibility(project("private", "olga"), owner)).toBe(true);
    expect(canChangeVisibility(project("private", "carol"), owner)).toBe(false);
    expect(canChangeVisibility(project("shared", "bob", globex), owner)).toBe(false);
  });

  it("an owner of another organization sees nothing here, shared or not", () => {
    expect(canSeeProject(project("shared", "bob"), outsider)).toBe(false);
    expect(canManageProject(project("shared", "bob"), outsider)).toBe(false);
  });
});

describe("removal and links", () => {
  const owner = viewer("olga", "owner");
  const carol = viewer("carol", "member");

  it("removal is an owner's, or the creator's for a private project only", () => {
    expect(canRemoveProject(project("shared", "carol"), owner)).toBe(true);
    expect(canRemoveProject(project("shared", "carol"), carol)).toBe(false);
    expect(canRemoveProject(project("private", "carol"), carol)).toBe(true);
    expect(canRemoveProject(project("private", "carol"), owner)).toBe(false);
  });

  it("a link is usable only inside one organization and when the owner sees both ends", () => {
    const shared = project("shared", "olga");
    expect(canUseLink(shared, project("shared", "mo"), carol)).toBe(true);
    expect(canUseLink(shared, project("private", "carol"), carol)).toBe(true);
    expect(canUseLink(shared, project("private", "olga"), carol)).toBe(false);
    expect(canUseLink(shared, project("shared", "bob", globex), carol)).toBe(false);
    expect(canUseLink(shared, project("shared", "mo"), null)).toBe(false);
  });
});

describe("invitations", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  const later = new Date("2026-09-24T12:00:00Z");
  const earlier = new Date("2026-09-01T12:00:00Z");

  it("is open until accepted, revoked, or past its expiry, in that precedence", () => {
    expect(invitationState({ acceptedAt: null, revokedAt: null, expiresAt: later }, now)).toBe(
      "open",
    );
    expect(invitationState({ acceptedAt: null, revokedAt: null, expiresAt: earlier }, now)).toBe(
      "expired",
    );
    expect(invitationState({ acceptedAt: null, revokedAt: now, expiresAt: later }, now)).toBe(
      "revoked",
    );
    expect(invitationState({ acceptedAt: now, revokedAt: null, expiresAt: earlier }, now)).toBe(
      "accepted",
    );
  });

  it("expiry is exclusive at the boundary", () => {
    expect(invitationState({ acceptedAt: null, revokedAt: null, expiresAt: now }, now)).toBe(
      "expired",
    );
  });
});

describe("organization names", () => {
  it("accepts a trimmed name within the limit", () => {
    expect(organizationNameIssue("  Acme  ")).toBeNull();
    expect(organizationNameIssue("a".repeat(64))).toBeNull();
  });

  it("refuses empty, over-long and control-character names", () => {
    expect(organizationNameIssue("   ")).toBe("An organization needs a name.");
    expect(organizationNameIssue("a".repeat(65))).toBe(
      "Organization names are at most 64 characters.",
    );
    expect(organizationNameIssue(`Acme${String.fromCharCode(7)}`)).toBe(
      "Organization names cannot contain control characters.",
    );
  });
});
