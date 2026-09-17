import { describe, expect, it } from "vitest";

import { TeamId } from "../ids.ts";
import { canManageProject, canViewProject, projectScope } from "./project.ts";
import { teamInviteState, teamNameIssue } from "./team.ts";

const platform = TeamId.make("team-platform");
const design = TeamId.make("team-design");

const standingOf = (memberOf: ReadonlyArray<TeamId>, ownerOf: ReadonlyArray<TeamId> = []) => ({
  memberOf: new Set(memberOf),
  ownerOf: new Set(ownerOf),
});

describe("project scope (docs/adr/0002)", () => {
  it("reads the two nullable columns as one scope, a team assignment first", () => {
    expect(projectScope({ teamId: null, ownerUserId: null })).toEqual({ kind: "instance" });
    expect(projectScope({ teamId: null, ownerUserId: "u1" })).toEqual({
      kind: "personal",
      ownerUserId: "u1",
    });
    expect(projectScope({ teamId: platform, ownerUserId: "u1" })).toEqual({
      kind: "team",
      teamId: platform,
    });
  });

  it("instance projects are visible to and manageable by every account", () => {
    const project = { teamId: null, ownerUserId: null };
    expect(canViewProject(project, "anyone", standingOf([]))).toBe(true);
    expect(canManageProject(project, "anyone", standingOf([]))).toBe(true);
  });

  it("personal projects belong to their owner alone", () => {
    const project = { teamId: null, ownerUserId: "owner" };
    expect(canViewProject(project, "owner", standingOf([]))).toBe(true);
    expect(canManageProject(project, "owner", standingOf([]))).toBe(true);
    expect(canViewProject(project, "other", standingOf([platform], [platform]))).toBe(false);
    expect(canManageProject(project, "other", standingOf([platform], [platform]))).toBe(false);
  });

  it("team projects: members work, owners manage, outsiders see nothing", () => {
    const project = { teamId: platform, ownerUserId: null };
    expect(canViewProject(project, "member", standingOf([platform]))).toBe(true);
    expect(canManageProject(project, "member", standingOf([platform]))).toBe(false);
    expect(canViewProject(project, "owner", standingOf([platform], [platform]))).toBe(true);
    expect(canManageProject(project, "owner", standingOf([platform], [platform]))).toBe(true);
    expect(canViewProject(project, "elsewhere", standingOf([design], [design]))).toBe(false);
    expect(canManageProject(project, "elsewhere", standingOf([design], [design]))).toBe(false);
  });

  it("a stale owner on a team project does not widen access", () => {
    const project = { teamId: platform, ownerUserId: "former-owner" };
    expect(canViewProject(project, "former-owner", standingOf([]))).toBe(false);
  });
});

describe("team invites", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const later = new Date("2026-09-19T12:00:00Z");
  const earlier = new Date("2026-09-01T12:00:00Z");

  it("is open until accepted, revoked, or past its expiry — in that precedence", () => {
    expect(teamInviteState({ acceptedAt: null, revokedAt: null, expiresAt: later }, now)).toBe(
      "open",
    );
    expect(teamInviteState({ acceptedAt: null, revokedAt: null, expiresAt: earlier }, now)).toBe(
      "expired",
    );
    expect(teamInviteState({ acceptedAt: null, revokedAt: now, expiresAt: later }, now)).toBe(
      "revoked",
    );
    expect(teamInviteState({ acceptedAt: now, revokedAt: now, expiresAt: earlier }, now)).toBe(
      "accepted",
    );
  });

  it("expiry is exclusive at the boundary", () => {
    expect(teamInviteState({ acceptedAt: null, revokedAt: null, expiresAt: now }, now)).toBe(
      "expired",
    );
  });
});

describe("team names", () => {
  it("accepts ordinary names and refuses empty, oversize, or control-character ones", () => {
    expect(teamNameIssue("Platform")).toBeNull();
    expect(teamNameIssue("  Platform  ")).toBeNull();
    expect(teamNameIssue("")).not.toBeNull();
    expect(teamNameIssue("   ")).not.toBeNull();
    expect(teamNameIssue("x".repeat(65))).not.toBeNull();
    expect(teamNameIssue("badname")).not.toBeNull();
  });
});
