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

/** The acts decided so far; approving and choosing join with their routes. */
export type ResourceAct =
  | { readonly kind: "read" }
  | { readonly kind: "propose" }
  | { readonly kind: "remove-proposal"; readonly proposedBy: string }
  | { readonly kind: "remove-definition" };

export const WORKSPACE_RESOURCE_REFUSAL =
  "a workspace reads resources and changes none · propose or remove them from the web app, VS Code, the phone or mend on your machine";

const MANAGER = "a manager's: the project's creator or an organization owner";

/**
 * Null when `actor` may do `act` in `project`, else the words that say whose act it is. Servers
 * refuse with it and clients derive their controls from it, so the two cannot disagree. Any member
 * who can see the project proposes (decision G1); settings are a manager's (decision S12).
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
  }
};
