import type { OrganizationId } from "../ids.ts";
import type { OrganizationRole, ProjectVisibility } from "./organization.ts";

// Who may see and change what in an organization: plain rules, free of Effect, so a client
// that checks them loads no Schema (`./organization.ts` holds the Schemas and re-exports these).

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

/**
 * Removing, restoring or purging a shared project belongs to an organization owner;
 * a private project belongs to its creator. A member-creator cannot purge shared work.
 */
export const canRemoveProject = (project: ProjectTenancy, viewer: Viewer): boolean =>
  canSeeProject(project, viewer) &&
  (viewer.role === "owner" ||
    (project.visibility === "private" && project.createdByUserId === viewer.userId));

/**
 * Whether a session in `project` may mount the linked project for its owner: same organization,
 * and the owner can see the target. Checked when a link is created and again at every launch,
 * because visibility and membership change.
 */
export const canUseLink = (
  project: ProjectTenancy,
  linked: ProjectTenancy,
  owner: Viewer | null,
): boolean =>
  owner !== null &&
  linked.organizationId === project.organizationId &&
  canSeeProject(project, owner) &&
  canSeeProject(linked, owner);

/**
 * Whether a repository of `nested` may be saved inside a worktree of `host`
 * (docs/adr/0011-repositories-in-a-session.md, decision 14). The repository's files and history
 * ride that worktree's captures, and anyone who can see `host` can open the worktree and receive
 * them, so everyone who can see `host` must be able to see `nested`. A shared project is seen by
 * its whole organization, so any project of that organization may hold it. A private project is
 * seen by its creator only, so only a private project of the same creator may hold it. Membership
 * is not counted: a shared project's audience grows with every member who joins.
 */
export const canNestRepository = (host: ProjectTenancy, nested: ProjectTenancy): boolean =>
  host.organizationId === nested.organizationId &&
  (nested.visibility === "shared" ||
    (host.visibility === "private" &&
      host.createdByUserId !== null &&
      host.createdByUserId === nested.createdByUserId));

/** Private or shared is an owner decision after adoption. */
export const canChangeVisibility = (project: ProjectTenancy, viewer: Viewer): boolean =>
  canSeeProject(project, viewer) && viewer.role === "owner";
