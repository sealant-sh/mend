import { OrganizationId } from "@mend/domain";
import { Organization } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { OneTimeLink, OrganizationRejected } from "./organization.ts";

/**
 * The operator's recovery surface (docs/adr/0003-organizations-and-tenancy.md, "Operator" and
 * "Recovery"). The operator administers the instance, not organization content: it lists and
 * names organizations, hands a new owner their way in, and issues password reset links. Everyone
 * else gets 404. Each act is recorded in the affected organization's audit log.
 */

export class OrganizationSummary extends Schema.Class<OrganizationSummary>("OrganizationSummary")({
  organization: Organization,
  memberCount: Schema.Int,
  ownerCount: Schema.Int,
}) {}

export class OrganizationNameRequest extends Schema.Class<OrganizationNameRequest>(
  "OrganizationNameRequest",
)({
  name: Schema.String,
}) {}

export class OwnerInvitationRequest extends Schema.Class<OwnerInvitationRequest>(
  "OwnerInvitationRequest",
)({
  email: Schema.optional(Schema.String),
  expiresInDays: Schema.optional(Schema.Int),
}) {}

export class AccountEmailRequest extends Schema.Class<AccountEmailRequest>("AccountEmailRequest")({
  email: Schema.String,
}) {}

export const operatorGroup = HttpApiGroup.make("operator")
  .add(
    HttpApiEndpoint.get("organizations", "/operator/organizations", {
      success: Schema.Array(OrganizationSummary),
      error: NotFound,
    }),
  )
  .add(
    // `multi` only: a single-organization install keeps its one organization.
    HttpApiEndpoint.post("createOrganization", "/operator/organizations", {
      payload: OrganizationNameRequest,
      success: Organization,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("renameOrganization", "/operator/organizations/:id/name", {
      params: Schema.Struct({ id: OrganizationId }),
      payload: OrganizationNameRequest,
      success: Organization,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    // An owner invitation into any organization: how an empty or ownerless one gets an owner.
    HttpApiEndpoint.post("inviteOwner", "/operator/organizations/:id/invitations", {
      params: Schema.Struct({ id: OrganizationId }),
      payload: OwnerInvitationRequest,
      success: OneTimeLink,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    // Make an existing member an owner.
    HttpApiEndpoint.post("grantOwner", "/operator/organizations/:id/owners", {
      params: Schema.Struct({ id: OrganizationId }),
      payload: AccountEmailRequest,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .add(
    HttpApiEndpoint.post("issuePasswordReset", "/operator/password-resets", {
      payload: AccountEmailRequest,
      success: OneTimeLink,
      error: [NotFound, OrganizationRejected],
    }),
  )
  .middleware(AuthMiddleware);
