import { Schema } from "effect";

import { InvitationId, OrganizationId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * The tenant (docs/adr/0003-organizations-and-tenancy.md). An organization owns its members,
 * projects, folders, reference repositories and audit log. An account belongs to exactly one.
 * Owners also invite and remove people, change roles and project visibility, and run recovery;
 * members work in the projects they can see.
 */
export const OrganizationRole = Schema.Literals(["owner", "member"]);
export type OrganizationRole = typeof OrganizationRole.Type;

/**
 * An instance role, separate from organization ownership. The operator administers the
 * machine and has no default read access to organization content.
 */
export const InstanceRole = Schema.Literals(["operator"]);
export type InstanceRole = typeof InstanceRole.Type;

/**
 * `MEND_TENANCY`. `single` fixes the organization count at one; `multi` hosts many and stays
 * refused until the multi mode gate passes. The authorization model is the same in both.
 */
export const TenancyMode = Schema.Literals(["single", "multi"]);
export type TenancyMode = typeof TenancyMode.Type;

/** Who may see a project: its creator only, or every member of its organization. */
export const ProjectVisibility = Schema.Literals(["private", "shared"]);
export type ProjectVisibility = typeof ProjectVisibility.Type;

export class Organization extends Schema.Class<Organization>("Organization")({
  id: OrganizationId,
  /** Display name, unique per instance after trimming and case folding. */
  name: Schema.String,
  /** The account that created it; null for the organization the upgrade created. */
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** One account's membership, with the account's public facts beside it. */
export class OrganizationMember extends Schema.Class<OrganizationMember>("OrganizationMember")({
  organizationId: OrganizationId,
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: OrganizationRole,
  joinedAt: Timestamp,
}) {}

/**
 * A single-use invitation link. The token is shown once when minted; only its sha256 is stored,
 * so the row can say who it was for and whether it was used, never re-issue the link.
 */
export class Invitation extends Schema.Class<Invitation>("Invitation")({
  id: InvitationId,
  organizationId: OrganizationId,
  role: OrganizationRole,
  /** When set, only the account with this email can accept. */
  email: Schema.NullOr(Schema.String),
  createdByUserId: Schema.String,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  acceptedByUserId: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Timestamp),
  revokedAt: Schema.NullOr(Timestamp),
}) {}

/** What one invitation can do right now. */
export type InvitationState = "open" | "accepted" | "revoked" | "expired";

export const invitationState = (
  invitation: Pick<Invitation, "acceptedAt" | "revokedAt" | "expiresAt">,
  now: Date,
): InvitationState => {
  if (invitation.acceptedAt !== null) return "accepted";
  if (invitation.revokedAt !== null) return "revoked";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
};

export const ORGANIZATION_MAX_NAME_LENGTH = 64;
export const INVITATION_DEFAULT_DAYS = 7;
export const INVITATION_MAX_DAYS = 30;

/** The caller-visible problem with an organization name, or null when it is accepted. */
export const organizationNameIssue = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed === "") return "An organization needs a name.";
  if (trimmed.length > ORGANIZATION_MAX_NAME_LENGTH) {
    return `Organization names are at most ${ORGANIZATION_MAX_NAME_LENGTH} characters.`;
  }
  if (/\p{Cc}/u.test(trimmed)) return "Organization names cannot contain control characters.";
  return null;
};

/** The signed-in account as authorization sees it: which organization, in which role. */
export interface Viewer {
  readonly userId: string;
  readonly organizationId: OrganizationId;
  readonly role: OrganizationRole;
}

/** The project facts authorization reads. */
export interface ProjectTenancy {
  readonly organizationId: OrganizationId;
  readonly visibility: ProjectVisibility;
  readonly createdByUserId: string | null;
}

/**
 * Visibility is the working permission. A shared project is visible to its organization; a
 * private one to its creator only. Owners do not see other members' private projects: taking
 * one over is an explicit recovery action.
 */
export const canSeeProject = (project: ProjectTenancy, viewer: Viewer): boolean =>
  project.organizationId === viewer.organizationId &&
  (project.visibility === "shared" || project.createdByUserId === viewer.userId);

/** Settings, removal and launch inputs: an owner, or the member who created the project. */
export const canManageProject = (project: ProjectTenancy, viewer: Viewer): boolean =>
  canSeeProject(project, viewer) &&
  (viewer.role === "owner" || project.createdByUserId === viewer.userId);

/** Private or shared is an owner decision after adoption. */
export const canChangeVisibility = (project: ProjectTenancy, viewer: Viewer): boolean =>
  canSeeProject(project, viewer) && viewer.role === "owner";
