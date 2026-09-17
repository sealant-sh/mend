import { InvitationId, OrganizationId, ProjectId } from "@mend/domain";
import {
  AuditEvent,
  Invitation,
  Organization,
  OrganizationMember,
  OrganizationRole,
  Project,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * The caller's organization (docs/adr/0003-organizations-and-tenancy.md). Every route acts as the
 * signed-in account in its one organization. Owner-only actions from a member answer 404, like
 * anything else the caller cannot see.
 */

/** A request the organization rules refuse; the message says which rule. */
export class OrganizationRejected extends Schema.TaggedErrorClass<OrganizationRejected>()(
  "OrganizationRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The invitation exists but is spent: accepted, revoked, or past its expiry. */
export class InvitationSpent extends Schema.TaggedErrorClass<InvitationSpent>()(
  "InvitationSpent",
  { state: Schema.Literals(["accepted", "revoked", "expired"]) },
  { httpApiStatus: 409 },
) {}

/** The caller's organization, their role in it, and whether they also operate the instance. */
export class OrganizationView extends Schema.Class<OrganizationView>("OrganizationView")({
  organization: Organization,
  /** The signed-in account, so a roster can mark "you". */
  userId: Schema.String,
  role: OrganizationRole,
  memberCount: Schema.Int,
  operator: Schema.Boolean,
  /** `single`: the organization stays out of the way. `multi`: its name is shown. */
  tenancy: Schema.Literals(["single", "multi"]),
  /** `none`: selected folders are recorded but not mounted into captured workspaces yet. */
  mountDelivery: Schema.Literals(["bind", "none"]),
}) {}

/** One audit event with the name of the account that acted, departed members included. */
export class AuditEntry extends Schema.Class<AuditEntry>("AuditEntry")({
  event: AuditEvent,
  actorName: Schema.String,
  /** The account a member event is about, by name, removed members included; null otherwise. */
  subjectName: Schema.NullOr(Schema.String),
}) {}

export class CreateInvitationRequest extends Schema.Class<CreateInvitationRequest>(
  "CreateInvitationRequest",
)({
  role: OrganizationRole,
  /** Bind acceptance to one account's email; omitted means whoever holds the link. */
  email: Schema.optional(Schema.String),
  /** Days until the link stops working; the server clamps it to its maximum. */
  expiresInDays: Schema.optional(Schema.Int),
}) {}

/** The one time the token is visible: the row plus the path a browser opens to accept it. */
export class InvitationCreated extends Schema.Class<InvitationCreated>("InvitationCreated")({
  invitation: Invitation,
  token: Schema.String,
  /** Relative to the web app's origin; the caller knows which host it reached. */
  path: Schema.String,
}) {}

/**
 * What a join link shows before anyone signs in. Deliberately without the bound email or the
 * inviter: holding the link must not reveal who it was meant for.
 */
export class InvitationPreview extends Schema.Class<InvitationPreview>("InvitationPreview")({
  /** Tells organizations with the same name apart for a signed-in visitor. */
  organizationId: OrganizationId,
  organizationName: Schema.String,
  role: OrganizationRole,
  state: Schema.Literals(["open", "accepted", "revoked", "expired"]),
  expiresAt: Schema.Date,
}) {}

export class MemberRoleRequest extends Schema.Class<MemberRoleRequest>("MemberRoleRequest")({
  role: OrganizationRole,
}) {}

/** A one-time link handed over by hand: relative to the web app's origin, and when it dies. */
export class OneTimeLink extends Schema.Class<OneTimeLink>("OneTimeLink")({
  path: Schema.String,
  expiresAt: Schema.Date,
}) {}

export const organizationGroup = HttpApiGroup.make("organization")
  .add(
    HttpApiEndpoint.get("current", "/organization", {
      success: OrganizationView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("members", "/organization/members", {
      success: Schema.Array(OrganizationMember),
      error: NotFound,
    }),
  )
  .add(
    // Owners only; spent invitations included so the list can say what happened to them.
    HttpApiEndpoint.get("invitations", "/organization/invitations", {
      success: Schema.Array(Invitation),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("createInvitation", "/organization/invitations", {
      payload: CreateInvitationRequest,
      success: InvitationCreated,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeInvitation", "/organization/invitations/:id", {
      params: Schema.Struct({ id: InvitationId }),
      success: Invitation,
      error: [NotFound, InvitationSpent],
    }),
  )
  .add(
    // Owners only. Deactivates the account, revokes its sign-ins, closes its connections and
    // stops its sessions; refused for the last owner.
    HttpApiEndpoint.delete("removeMember", "/organization/members/:userId", {
      params: Schema.Struct({ userId: Schema.String }),
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("setMemberRole", "/organization/members/:userId/role", {
      params: Schema.Struct({ userId: Schema.String }),
      payload: MemberRoleRequest,
      success: OrganizationMember,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    // Owners only, for a member (not another owner; the operator resets owners). The link sets a
    // new password once and signs the account out everywhere.
    HttpApiEndpoint.post("issuePasswordReset", "/organization/members/:userId/password-reset", {
      params: Schema.Struct({ userId: Schema.String }),
      success: OneTimeLink,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    // Owners only: projects whose creator no longer belongs to the organization.
    HttpApiEndpoint.get("orphanedProjects", "/organization/orphaned-projects", {
      success: Schema.Array(Project),
      error: NotFound,
    }),
  )
  .add(
    // Owners only: become the creator of a project whose creator left.
    HttpApiEndpoint.post("takeOverProject", "/organization/projects/:id/takeover", {
      params: Schema.Struct({ id: ProjectId }),
      success: Project,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    // Owners only; newest first. `before` is the id of the previous page's last event.
    HttpApiEndpoint.get("audit", "/organization/audit", {
      query: { before: Schema.optional(Schema.String), limit: Schema.optional(Schema.String) },
      success: Schema.Array(AuditEntry),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** The token of the link being previewed. */
export class InvitationPreviewRequest extends Schema.Class<InvitationPreviewRequest>(
  "InvitationPreviewRequest",
)({
  token: Schema.String,
}) {}

/**
 * Public by design: the join page reads it before the visitor has an account. A POST, so the
 * token stays out of request lines and the access logs that record them.
 */
export const invitationsGroup = HttpApiGroup.make("invitations").add(
  HttpApiEndpoint.post("preview", "/invitations/preview", {
    payload: InvitationPreviewRequest,
    success: InvitationPreview,
    error: NotFound,
  }),
);
