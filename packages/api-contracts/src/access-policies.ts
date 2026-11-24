import { AccessPolicyId, ProjectId, WorktreeId } from "@mend/domain";
import {
  AccessPolicy,
  AccessPolicyRules,
  AccessRevocation,
  AccessRevocationKind,
  ProjectAccessPolicy,
  WorktreeAccessPolicyPin,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

/**
 * Access policies (ADR 0025's 2026-11-24 amendment; agent-home
 * `docs/workspace-isolation-architecture.md` §7–§8). Organization → Access policies holds the
 * templates; every member reads them, only Organization Owners write them or revoke access. A
 * project holds its own copy of one template, assigned by whoever manages the project (an
 * elevated one by an Organization Owner only). A worktree pins the rules it started with; "Apply
 * updated policy" re-pins it to its project's copy. A policy holds rules only, never a secret value.
 */

/** A policy or revocation breaks a rule; `problems` names every one, in sentences a page can show. */
export class AccessPolicyRejected extends Schema.TaggedError<AccessPolicyRejected>()(
  "AccessPolicyRejected",
  { message: Schema.String, problems: Schema.Array(Schema.String) },
  { httpApiStatus: 400 },
) {}

/** Another policy in the organization already has that name, in any letter case. */
export class AccessPolicyNameTaken extends Schema.TaggedError<AccessPolicyNameTaken>()(
  "AccessPolicyNameTaken",
  { name: Schema.String, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The policy changed since the caller read it; `currentRevision` is what it is now. */
export class AccessPolicyStaleWrite extends Schema.TaggedError<AccessPolicyStaleWrite>()(
  "AccessPolicyStaleWrite",
  { policyId: AccessPolicyId, currentRevision: Schema.Int, message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Standard is built in: it is never edited or removed. */
export class AccessPolicyBuiltIn extends Schema.TaggedError<AccessPolicyBuiltIn>()(
  "AccessPolicyBuiltIn",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * Only an Organization Owner does this: write a policy, revoke access, assign an elevated policy
 * to a project, or turn a Brokered secret back to Direct. The caller can see what they asked about.
 */
export class AccessPolicyOwnersOnly extends Schema.TaggedError<AccessPolicyOwnersOnly>()(
  "AccessPolicyOwnersOnly",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** "Apply updated policy" could not be applied; the message says why. Nothing was pushed. */
export class AccessPolicyNotApplied extends Schema.TaggedError<AccessPolicyNotApplied>()(
  "AccessPolicyNotApplied",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The organization's policies, its revocations, and the server's private-destination ceiling. */
export class AccessPoliciesView extends Schema.Class<AccessPoliciesView>("AccessPoliciesView")({
  /** Standard first, then the organization's own by name. */
  policies: Schema.Array(AccessPolicy),
  /** Oldest first. */
  revocations: Schema.Array(AccessRevocation),
  /**
   * `MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS` as this server reads it: every private destination a
   * policy opens lies inside one of these. Empty: no policy here opens any.
   */
  privateEgressCeiling: Schema.Array(Schema.String),
}) {}

export class CreateAccessPolicyRequest extends Schema.Class<CreateAccessPolicyRequest>(
  "CreateAccessPolicyRequest",
)({
  name: Schema.String,
  rules: AccessPolicyRules,
}) {}

export class UpdateAccessPolicyRequest extends Schema.Class<UpdateAccessPolicyRequest>(
  "UpdateAccessPolicyRequest",
)({
  name: Schema.String,
  rules: AccessPolicyRules,
  /** The revision the caller read; a newer one refuses the write. */
  expectedRevision: Schema.Int,
}) {}

/**
 * A durable revocation. `policyId` reaches worktrees whose policy came from that template; null
 * reaches every worktree in the organization. `target` is the host (`host`) or the project
 * secret's id (`secret`), and null for `all`.
 */
export class RevokeAccessRequest extends Schema.Class<RevokeAccessRequest>("RevokeAccessRequest")({
  policyId: Schema.NullOr(AccessPolicyId),
  kind: AccessRevocationKind,
  target: Schema.NullOr(Schema.String),
}) {}

/** What became of a policy change or revocation on one running workspace. */
export class WorkspaceEnforcementView extends Schema.Class<WorkspaceEnforcementView>(
  "WorkspaceEnforcementView",
)({
  workspaceId: Schema.String,
  /**
   * sealant's answer: `enforced` now, `pending` while it applies, `next-start` when the
   * workspace takes it as it next starts. `failed`: sealant did not take it; `message` says why.
   */
  enforcement: Schema.Literals(["enforced", "pending", "next-start", "failed"]),
  message: Schema.NullOr(Schema.String),
}) {}

/** A stored revocation, and each running workspace it reached. */
export class AccessRevoked extends Schema.Class<AccessRevoked>("AccessRevoked")({
  revocation: AccessRevocation,
  workspaces: Schema.Array(WorkspaceEnforcementView),
}) {}

export const accessPoliciesGroup = HttpApiGroup.make("accessPolicies")
  .add(
    // Every member.
    HttpApiEndpoint.get("list", "/organization/access-policies", {
      success: AccessPoliciesView,
      error: NotFound,
    }),
  )
  .add(
    // Organization Owners only. Audited as `access_policy.created`.
    HttpApiEndpoint.post("create", "/organization/access-policies", {
      payload: CreateAccessPolicyRequest,
      success: AccessPolicy,
      error: [NotFound, AccessPolicyRejected, AccessPolicyNameTaken, AccessPolicyOwnersOnly],
    }),
  )
  .add(
    // Organization Owners only. A new revision; projects keep the copy they took. Audited as
    // `access_policy.updated`.
    HttpApiEndpoint.put("update", "/organization/access-policies/:id", {
      params: { id: AccessPolicyId },
      payload: UpdateAccessPolicyRequest,
      success: AccessPolicy,
      error: [
        NotFound,
        AccessPolicyRejected,
        AccessPolicyNameTaken,
        AccessPolicyStaleWrite,
        AccessPolicyBuiltIn,
        AccessPolicyOwnersOnly,
      ],
    }),
  )
  .add(
    // Organization Owners only. Projects keep their copies, which no longer name a live template.
    // Audited as `access_policy.removed`.
    HttpApiEndpoint.delete("remove", "/organization/access-policies/:id", {
      params: { id: AccessPolicyId },
      success: AccessPolicy,
      error: [NotFound, AccessPolicyBuiltIn, AccessPolicyOwnersOnly],
    }),
  )
  .add(
    // Organization Owners only. Stored first, then pushed to every running workspace it reaches;
    // it wins over every pin from then on. Audited as `access_policy.revoked`.
    HttpApiEndpoint.post("revoke", "/organization/access-policies/revocations", {
      payload: RevokeAccessRequest,
      success: AccessRevoked,
      error: [NotFound, AccessPolicyRejected, AccessPolicyOwnersOnly],
    }),
  )
  .middleware(AuthMiddleware);

/** A project's own policy, and how it stands against the template it was copied from. */
export class ProjectAccessPolicyView extends Schema.Class<ProjectAccessPolicyView>(
  "ProjectAccessPolicyView",
)({
  policy: ProjectAccessPolicy,
  elevated: Schema.Boolean,
  /** The template's revision now, when it is newer than the copy; null otherwise. */
  latestRevision: Schema.NullOr(Schema.Int),
  /** The template the copy came from was removed; the copy stays as it is. */
  sourceRemoved: Schema.Boolean,
}) {}

export class AssignAccessPolicyRequest extends Schema.Class<AssignAccessPolicyRequest>(
  "AssignAccessPolicyRequest",
)({
  policyId: AccessPolicyId,
}) {}

export const projectAccessPolicyGroup = HttpApiGroup.make("projectAccessPolicy")
  .add(
    // Whoever can open the project.
    HttpApiEndpoint.get("get", "/projects/:id/access-policy", {
      params: { id: ProjectId },
      success: ProjectAccessPolicyView,
      error: NotFound,
    }),
  )
  .add(
    // Whoever manages the project (an Organization Owner or its creator); an elevated policy
    // takes an Organization Owner. Copies the template's rules; existing worktrees keep their
    // pins. Audited as `project.access_policy_assigned`.
    HttpApiEndpoint.put("set", "/projects/:id/access-policy", {
      params: { id: ProjectId },
      payload: AssignAccessPolicyRequest,
      success: ProjectAccessPolicyView,
      error: [NotFound, AccessPolicyOwnersOnly, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);

/** A worktree's pinned policy, what it may use now, and whether its project's copy moved on. */
export class WorktreeAccessPolicyView extends Schema.Class<WorktreeAccessPolicyView>(
  "WorktreeAccessPolicyView",
)({
  /** Null: a worktree from before Access policies, which reads as Standard. */
  pin: Schema.NullOr(WorktreeAccessPolicyPin),
  /** The pin less every revocation that reaches it. */
  effective: AccessPolicyRules,
  /** The organization's revocations that reach this worktree, oldest first. */
  revocations: Schema.Array(AccessRevocation),
  /** The project's own policy reads differently from the pin: "Apply updated policy" would change it. */
  projectPolicyDiffers: Schema.Boolean,
}) {}

/** What "Apply updated policy" did: the new pin, and each running workspace's answer. */
export class AppliedAccessPolicyView extends Schema.Class<AppliedAccessPolicyView>(
  "AppliedAccessPolicyView",
)({
  pin: WorktreeAccessPolicyPin,
  workspaces: Schema.Array(WorkspaceEnforcementView),
}) {}

export const worktreeAccessPolicyGroup = HttpApiGroup.make("worktreeAccessPolicy")
  .add(
    // Whoever can open the worktree's project.
    HttpApiEndpoint.get("get", "/worktrees/:id/access-policy", {
      params: { id: WorktreeId },
      success: WorktreeAccessPolicyView,
      error: NotFound,
    }),
  )
  .add(
    // "Apply updated policy": whoever may start sessions in the project. Re-pins the worktree to
    // its project's copy and pushes it to each running workspace; revocations still apply on top.
    HttpApiEndpoint.post("apply", "/worktrees/:id/access-policy/apply", {
      params: { id: WorktreeId },
      success: AppliedAccessPolicyView,
      error: [NotFound, AccessPolicyNotApplied, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
