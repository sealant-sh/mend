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

export type ResourceAct =
  | { readonly kind: "read" }
  /**
   * Adding a definition under its name: `replaces` names who added the definition settings hold
   * under that name, which this add would change; null when it changes none.
   */
  | { readonly kind: "add"; readonly replaces: { readonly addedBy: string } | null }
  | { readonly kind: "remove-definition"; readonly addedBy: string }
  /** Choosing `off`, `shared` or `own` for one worktree. */
  | { readonly kind: "use"; readonly changeOwner: string | null };

export const WORKSPACE_RESOURCE_REFUSAL =
  "a workspace reads resources and changes none · add, remove or choose them from the web app, VS Code, the phone or mend on your machine";

const MANAGER = "a manager's: the project's creator or an organization owner";

const CHANGE_OWNER = "its change owner's: the owner of its first session";

/** Null when `viewer` owns the worktree's change, else why its acts are not theirs. */
const changeOwnerRefusal = (changeOwner: string | null, viewer: Viewer, act: string) =>
  changeOwner === viewer.userId
    ? null
    : changeOwner === null
      ? `${act} is the change owner's, and this worktree has no first session with an owner yet`
      : `${act} is ${CHANGE_OWNER}`;

/** Null when `viewer` added the definition or manages the project, else whose `act` it is. */
const adderRefusal = (
  project: ProjectTenancy,
  viewer: Viewer,
  addedBy: string,
  act: string,
): string | null =>
  addedBy === viewer.userId || canManageProject(project, viewer)
    ? null
    : `${act} someone else added is theirs or ${MANAGER}`;

/**
 * Null when `actor` may do `act` in `project`, else the words that say whose act it is. Servers
 * refuse with it and clients derive their controls from it, so the two cannot disagree. Any member
 * who can see the project reads and adds a resource, and it is the project's from then on; a
 * definition someone else added is replaced or removed by them or a manager. A worktree's choice
 * is its change owner's alone, a manager's included.
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
      return null;
    case "add":
      return act.replaces === null
        ? null
        : adderRefusal(project, viewer, act.replaces.addedBy, "replacing a definition");
    case "remove-definition":
      return adderRefusal(project, viewer, act.addedBy, "removing a definition");
    case "use":
      return changeOwnerRefusal(
        act.changeOwner,
        viewer,
        "choosing how this worktree uses a resource",
      );
  }
};
