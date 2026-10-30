import {
  canManageProject,
  canSeeProject,
  type ProjectTenancy,
  type Viewer,
} from "./organization.ts";

/**
 * Who asks about a project's resources (ADR 0019, "Who may do what"). A workspace is a call
 * through its session's socket or channel. A call on the account API is the person whose token
 * it carries, wherever that token was used (ADR 0017's build draws the same line).
 */
export type ResourceActor =
  | { readonly kind: "person"; readonly viewer: Viewer }
  | { readonly kind: "workspace" };

/**
 * Who an approval is for: the project, or one worktree, whose change owner (the owner of its
 * first session, ADR 0007) is null until it has a first session with an owner.
 */
export type ResourceApprovalFor =
  | { readonly kind: "project" }
  | { readonly kind: "worktree"; readonly changeOwner: string | null };

export type ResourceAct =
  | { readonly kind: "read" }
  | { readonly kind: "propose" }
  | { readonly kind: "remove-proposal"; readonly proposedBy: string }
  | { readonly kind: "remove-definition" }
  /** `replaces`: the approval adopts a spec over a different one that settings hold. */
  | { readonly kind: "approve"; readonly for: ResourceApprovalFor; readonly replaces: boolean }
  /** Choosing `off`, `shared` or `own` for one worktree. */
  | { readonly kind: "use"; readonly changeOwner: string | null };

export const WORKSPACE_RESOURCE_REFUSAL =
  "a workspace reads resources and changes none · propose, approve or choose them from the web app, VS Code, the phone or mend on your machine";

const MANAGER = "a manager's: the project's creator or an organization owner";

const CHANGE_OWNER = "its change owner's: the owner of its first session";

/** Null when `viewer` owns the worktree's change, else why its acts are not theirs. */
const changeOwnerRefusal = (changeOwner: string | null, viewer: Viewer, act: string) =>
  changeOwner === viewer.userId
    ? null
    : changeOwner === null
      ? `${act} is the change owner's, and this worktree has no first session with an owner yet`
      : `${act} is ${CHANGE_OWNER}`;

/**
 * Null when `actor` may do `act` in `project`, else the words that say whose act it is. Servers
 * refuse with it and clients derive their controls from it, so the two cannot disagree. Any member
 * who can see the project proposes (decision G1); settings are a manager's (decision S12). A
 * worktree's approval and choice are its change owner's alone, a manager's included (decision
 * G4): the change owner may adopt a worktree resource settings do not hold yet, and its image must
 * be one a manager approved, which the approval's own transaction checks.
 */
export const resourceActRefusal = (
  project: ProjectTenancy,
  actor: ResourceActor,
  act: ResourceAct,
): string | null => {
  if (actor.kind === "workspace") return act.kind === "read" ? null : WORKSPACE_RESOURCE_REFUSAL;
  const { viewer } = actor;
  if (!canSeeProject(project, viewer)) return "is not a project you can see";
  switch (act.kind) {
    case "read":
    case "propose":
      return null;
    case "remove-proposal":
      return act.proposedBy === viewer.userId || canManageProject(project, viewer)
        ? null
        : `removing another person's proposal is theirs or ${MANAGER}`;
    case "remove-definition":
      return canManageProject(project, viewer) ? null : `removing a definition is ${MANAGER}`;
    case "approve": {
      const manager = canManageProject(project, viewer);
      if (act.for.kind === "project") {
        return manager ? null : `approving a resource for the project is ${MANAGER}`;
      }
      const owner = changeOwnerRefusal(
        act.for.changeOwner,
        viewer,
        "approving a worktree resource for this worktree",
      );
      if (owner !== null) return owner;
      return act.replaces && !manager
        ? `replacing the definition settings hold is ${MANAGER}`
        : null;
    }
    case "use":
      return changeOwnerRefusal(
        act.changeOwner,
        viewer,
        "choosing how this worktree uses a resource",
      );
  }
};
