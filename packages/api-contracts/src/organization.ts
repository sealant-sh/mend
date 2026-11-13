import {
  InvitationId,
  MendSettings,
  OrganizationId,
  OrganizationSettings,
  ProjectId,
  RuntimeSupportReading,
  SessionRuntime,
  WorkspaceImage,
} from "@mend/domain";
import {
  AuditEvent,
  Invitation,
  ResourceArchive,
  Organization,
  OrganizationMember,
  OrganizationRole,
  Project,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AccessKeyRefused, AuthMiddleware, PersonCredentialOnly } from "./common.ts";
import { SettingsFailure, WorkspacePackageResolutionView } from "./workbench-views.ts";

/**
 * The caller's organization (docs/adr/0003-organizations-and-tenancy.md). Every route acts as the
 * signed-in account in the organization its sign-in has active (`accountOrganizations`). Owner-only
 * actions from a member answer 404, like anything else the caller cannot see.
 */

/** A request the organization rules refuse; the message says which rule. */
export class OrganizationRejected extends Schema.TaggedError<OrganizationRejected>()(
  "OrganizationRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The invitation exists but is spent: accepted, revoked, or past its expiry. */
export class InvitationSpent extends Schema.TaggedError<InvitationSpent>()(
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
  mountDelivery: Schema.Literals(["bind", "sources"]),
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

/**
 * Where the organization's new sessions run (SLNT-794). The operator declares what the server
 * offers and its default; an owner chooses among them. Existing worktrees keep where they run.
 */
export class OrganizationSessionRuntimeView extends Schema.Class<OrganizationSessionRuntimeView>(
  "OrganizationSessionRuntimeView",
)({
  /** The organization's own choice; null follows the server's default. */
  chosen: Schema.NullOr(SessionRuntime),
  /** Where its new sessions run now; null where Sealant picks (Kubernetes with no offer). */
  effective: Schema.NullOr(SessionRuntime),
  /** What the server lets an organization choose; empty where Sealant picks. */
  offered: Schema.Array(SessionRuntime),
  /** What an organization that has not chosen gets; null where Sealant picks. */
  serverDefault: Schema.NullOr(SessionRuntime),
}) {}

/**
 * Where the organization's new sessions run and what that runtime supports, as Sealant reports it
 * (SLNT-795). Every member reads it; the environment pickers, the save refusals and the hot
 * sessions page read the same facts. Existing worktrees keep the runtime they were created on.
 */
export class OrganizationRuntimeView extends Schema.Class<OrganizationRuntimeView>(
  "OrganizationRuntimeView",
)({
  sessionRuntime: OrganizationSessionRuntimeView,
  /** What Sealant said that runtime supports, or why Mend could not read it. */
  support: RuntimeSupportReading,
}) {}

/** An owner's choice of where new sessions run; null follows the server's default again. */
export class OrganizationSessionRuntimeRequest extends Schema.Class<OrganizationSessionRuntimeRequest>(
  "OrganizationSessionRuntimeRequest",
)({
  sessionRuntime: Schema.NullOr(SessionRuntime),
}) {}

/**
 * The defaults every project in the organization inherits (docs/adr/0003, "Resources that were
 * instance-global"): the organization's own values, the instance's under them, and the result.
 */
export class OrganizationSettingsView extends Schema.Class<OrganizationSettingsView>(
  "OrganizationSettingsView",
)({
  /** The organization's own values; each null follows the instance. */
  organization: OrganizationSettings,
  /** The instance's settings, which the operator sets. */
  instance: MendSettings,
  /** What a project on inherit gets: `organization` wherever it is set, else `instance`. */
  effective: MendSettings,
  /** Whether the caller may change `organization`: its owners may. */
  editable: Schema.Boolean,
  /** Where the organization's new sessions run, beside what the server offers. */
  sessionRuntime: OrganizationSessionRuntimeView,
}) {}

/** The organization's workspace environment; null follows the instance's. */
export class OrganizationWorkspaceEnvironmentRequest extends Schema.Class<OrganizationWorkspaceEnvironmentRequest>(
  "OrganizationWorkspaceEnvironmentRequest",
)({
  workspaceImage: Schema.NullOr(WorkspaceImage),
}) {}

/**
 * Saving resolves family-mode packages exactly like the instance save; `saved: false` reports the
 * rejections and persists nothing.
 */
export class OrganizationWorkspaceEnvironmentSaveResult extends Schema.Class<OrganizationWorkspaceEnvironmentSaveResult>(
  "OrganizationWorkspaceEnvironmentSaveResult",
)({
  saved: Schema.Boolean,
  settings: OrganizationSettingsView,
  resolutions: Schema.Array(WorkspacePackageResolutionView),
}) {}

/**
 * A removal's account of the member's workspace SSH keys (docs/WORKSPACE-SSH.md). Keys the
 * platform did not archive now stay owed and the worker keeps trying; `sshKeysOutstanding` is how
 * many, or null when they could not be listed. Zero means none of theirs is active.
 */
export class MemberRemoved extends Schema.Class<MemberRemoved>("MemberRemoved")({
  sshKeysRemoved: Schema.Number,
  sshKeysOutstanding: Schema.NullOr(Schema.Number),
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
    }).middleware(PersonCredentialOnly),
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
    // stops its sessions; refused for the last owner, and an owner is never removed by an access
    // key (docs/adr/0023, decision 11).
    HttpApiEndpoint.delete("removeMember", "/organization/members/:userId", {
      params: Schema.Struct({ userId: Schema.String }),
      success: MemberRemoved,
      error: [NotFound, OrganizationRejected, AccessKeyRefused],
    }),
  )
  .add(
    // Owners only. An access key never grants ownership or changes an owner's role
    // (docs/adr/0023, decision 11).
    HttpApiEndpoint.put("setMemberRole", "/organization/members/:userId/role", {
      params: Schema.Struct({ userId: Schema.String }),
      payload: MemberRoleRequest,
      success: OrganizationMember,
      error: [NotFound, OrganizationRejected, AccessKeyRefused],
    }),
  )
  .add(
    // Owners only, for a member (not another owner; the operator resets owners). The link sets a
    // new password once and signs the account out everywhere. Never from an access key
    // (docs/adr/0023, decision 6).
    HttpApiEndpoint.post("issuePasswordReset", "/organization/members/:userId/password-reset", {
      params: Schema.Struct({ userId: Schema.String }),
      success: OneTimeLink,
      error: [NotFound, OrganizationRejected],
    }).middleware(PersonCredentialOnly),
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
    // Every member reads what their projects inherit; only owners may change it.
    HttpApiEndpoint.get("settings", "/organization/settings", {
      success: OrganizationSettingsView,
      error: NotFound,
    }),
  )
  .add(
    // Owners only. Replaces the organization's own values; a changed workspace environment is
    // resolved like the environment save below, and refused whole when a package does not resolve.
    HttpApiEndpoint.put("setSettings", "/organization/settings", {
      payload: OrganizationSettings,
      success: OrganizationSettingsView,
      error: [NotFound, SettingsFailure],
    }),
  )
  .add(
    // Every member: where new sessions run, and what Sealant says that runtime supports.
    HttpApiEndpoint.get("runtime", "/organization/runtime", {
      success: OrganizationRuntimeView,
      error: NotFound,
    }),
  )
  .add(
    // Owners only. A runtime the server does not offer is refused.
    HttpApiEndpoint.put("setSessionRuntime", "/organization/settings/session-runtime", {
      payload: OrganizationSessionRuntimeRequest,
      success: OrganizationSettingsView,
      error: [NotFound, SettingsFailure],
    }),
  )
  .add(
    // Owners only.
    HttpApiEndpoint.put("setWorkspaceEnvironment", "/organization/settings/workspace-environment", {
      payload: OrganizationWorkspaceEnvironmentRequest,
      success: OrganizationWorkspaceEnvironmentSaveResult,
      error: [NotFound, SettingsFailure],
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
  .add(
    HttpApiEndpoint.get("resourceArchives", "/organization/resource-archives", {
      success: Schema.Array(ResourceArchive),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** One organization the signed-in account belongs to, and whether this sign-in acts in it. */
export class AccountOrganization extends Schema.Class<AccountOrganization>("AccountOrganization")({
  organization: Organization,
  role: OrganizationRole,
  joinedAt: Schema.Date,
  active: Schema.Boolean,
}) {}

export class SwitchOrganizationRequest extends Schema.Class<SwitchOrganizationRequest>(
  "SwitchOrganizationRequest",
)({
  organizationId: OrganizationId,
}) {}

export class InvitationAcceptRequest extends Schema.Class<InvitationAcceptRequest>(
  "InvitationAcceptRequest",
)({
  token: Schema.String,
}) {}

/** The organization an accepted invitation joined, now this sign-in's active one. */
export class InvitationAccepted extends Schema.Class<InvitationAccepted>("InvitationAccepted")({
  organization: Organization,
  role: OrganizationRole,
}) {}

/**
 * The signed-in account's organizations (docs/adr/0003, "Organization switching"). Each sign-in
 * or paired device acts in one of them; switching moves only the sign-in that asked, ends the
 * streams and sockets it held in the organization it left, and makes the chosen one where a new
 * sign-in starts. Switching to or leaving an organization the account is not in answers 404.
 *
 * An access key acts in one organization and never another (docs/adr/0023, decision 3), and a
 * membership it joined would outlive it (decision 6), so every endpoint here refuses a key.
 */
export const accountOrganizationsGroup = HttpApiGroup.make("accountOrganizations")
  .add(
    HttpApiEndpoint.get("list", "/account/organizations", {
      success: Schema.Array(AccountOrganization),
    }),
  )
  .add(
    HttpApiEndpoint.put("switch", "/account/organizations/active", {
      payload: SwitchOrganizationRequest,
      success: AccountOrganization,
      error: NotFound,
    }),
  )
  .add(
    // Refused for the last owner, and for the account's only organization.
    HttpApiEndpoint.delete("leave", "/account/organizations/:id", {
      params: Schema.Struct({ id: OrganizationId }),
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    // The join page for a signed-in visitor: joins the invitation's organization and switches
    // this sign-in to it. A POST, so the token stays out of request lines and access logs.
    HttpApiEndpoint.post("acceptInvitation", "/invitations/accept", {
      payload: InvitationAcceptRequest,
      success: InvitationAccepted,
      error: [NotFound, InvitationSpent, OrganizationRejected],
    }),
  )
  .middleware(PersonCredentialOnly)
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
