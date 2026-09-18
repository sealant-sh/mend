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

/** One item of the multi mode gate as observed on this instance (docs/adr/0003). */
export class MultiModeGateItem extends Schema.Class<MultiModeGateItem>("MultiModeGateItem")({
  id: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
  fix: Schema.NullOr(Schema.String),
}) {}

/**
 * How an exposure gate item was established: read by this process (`observed`), contained in this
 * build where this process cannot see it in effect (`carried`), stated by the operator
 * (`declared`), or none of those (`open`).
 */
export const ExposureEstablished = Schema.Literals(["observed", "carried", "declared", "open"]);

/** One item of the public exposure gate as evaluated on this instance (docs/adr/0004). */
export class ExposureGateItem extends Schema.Class<ExposureGateItem>("ExposureGateItem")({
  id: Schema.String,
  established: ExposureEstablished,
  detail: Schema.String,
  /** What would close it; for an item no build can observe, what would verify it. */
  fix: Schema.NullOr(Schema.String),
  /** Whether an open item refuses a `public` start. */
  blocksStart: Schema.Boolean,
}) {}

export class ExposureReport extends Schema.Class<ExposureReport>("ExposureReport")({
  /** `MEND_EXPOSURE`, as the operator declared it. */
  declared: Schema.Literals(["loopback", "private", "public"]),
  items: Schema.Array(ExposureGateItem),
}) {}

export const operatorGroup = HttpApiGroup.make("operator")
  .add(
    // What was declared, and every gate item with how it was established.
    HttpApiEndpoint.get("exposure", "/operator/exposure", {
      success: ExposureReport,
      error: NotFound,
    }),
  )
  .add(
    // Every gate item with what was observed and what would satisfy it.
    HttpApiEndpoint.get("gate", "/operator/gate", {
      success: Schema.Array(MultiModeGateItem),
      error: NotFound,
    }),
  )
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
