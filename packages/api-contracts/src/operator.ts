import { OrganizationId } from "@mend/domain";
import { Organization, OrganizationRole } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, OperatorPersonCredentialOnly } from "./common.ts";
import { OneTimeLink, OrganizationRejected } from "./organization.ts";

/**
 * The operator's recovery surface (docs/adr/0003-organizations-and-tenancy.md, "Operator" and
 * "Recovery"). The operator administers the instance, not organization content: it lists and
 * names organizations, hands a new owner their way in, and issues password reset links. Everyone
 * else gets 404, and an access key gets 403 (docs/adr/0023, decision 10). Each act is recorded in
 * the affected organization's audit log.
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

/** An existing account to add to an organization, and its role there. */
export class OrganizationMemberRequest extends Schema.Class<OrganizationMemberRequest>(
  "OrganizationMemberRequest",
)({
  email: Schema.String,
  role: OrganizationRole,
}) {}

/**
 * Every gate item, of both gates, names its case in `reason` and carries that case's data in fields
 * of its own, beside `detail` and `fix`: the sentences the command line prints (`mend operator gate`,
 * `mend operator exposure`), with the same data inside them. A client that words an item for a
 * person reads the case and its fields, not the sentences. Each check is one member per case, so a
 * case carries exactly the fields it has.
 */
const variant = <
  const Id extends string,
  const Reason extends string,
  const Fields extends Schema.Struct.Fields,
>(
  id: Id,
  reason: Reason,
  fields: Fields,
) => ({ id: Schema.Literal(id), reason: Schema.Literal(reason), ...fields });

/** Removes the item's shared fields from every member of a union, leaving its case and data. */
type CaseOf<Item, Shared extends PropertyKey> = Item extends unknown ? Omit<Item, Shared> : never;

const Strings = Schema.Array(Schema.String);

const gateFields = {
  ok: Schema.Boolean,
  detail: Schema.String,
  fix: Schema.NullOr(Schema.String),
};

const gateItem = <const Id extends string, const Reason extends string>(id: Id, reason: Reason) =>
  Schema.Struct({ ...variant(id, reason, {}), ...gateFields });

/** One item of the multi mode gate as observed on this instance (docs/adr/0003). */
export const MultiModeGateItem = Schema.Union([
  gateItem("cross-organization-authorization", "built-in"),
  gateItem("per-account-resources", "built-in"),
  gateItem("folders-reach-workspaces", "captured"),
  gateItem("folders-reach-workspaces", "colocated"),
  gateItem("source-policy", "tenant"),
  gateItem("source-policy", "operator"),
  gateItem("source-address-pinning", "tenant"),
  gateItem("source-address-pinning", "operator"),
  gateItem("transport-bound-to-origin", "bound"),
  gateItem("transport-bound-to-origin", "unbound"),
  gateItem("upload-length-binding", "enforced"),
  gateItem("upload-length-binding", "no-sizes"),
  gateItem("upload-length-binding", "directory-store"),
  gateItem("daemon-declares-sizes", "built-in"),
  gateItem("raw-service-ports", "loopback"),
  Schema.Struct({
    ...variant("raw-service-ports", "exposed", { addresses: Strings }),
    ...gateFields,
  }),
  Schema.Struct({
    ...variant("operator-present", "operators", { count: Schema.Int }),
    ...gateFields,
  }),
]);
export type MultiModeGateItem = typeof MultiModeGateItem.Type;

/** A multi mode gate item's case and its data, without what every item has. */
export type MultiModeGateCase = CaseOf<MultiModeGateItem, keyof typeof gateFields>;

/**
 * How an exposure gate item was established: read by this process (`observed`), contained in this
 * build where this process cannot see it in effect (`carried`), stated by the operator
 * (`declared`), or none of those (`open`).
 */
export const ExposureEstablished = Schema.Literals(["observed", "carried", "declared", "open"]);

const exposureFields = {
  established: ExposureEstablished,
  detail: Schema.String,
  /** What would close it; for an item no build can observe, what would verify it. */
  fix: Schema.NullOr(Schema.String),
  /** Whether an open item refuses a `public` start. */
  blocksStart: Schema.Boolean,
};

const exposureItem = <
  const Id extends string,
  const Reason extends string,
  const Fields extends Schema.Struct.Fields,
>(
  id: Id,
  reason: Reason,
  fields: Fields,
) => Schema.Struct({ ...variant(id, reason, fields), ...exposureFields });

/** A case with no data of its own. */
const exposureCase = <const Id extends string, const Reason extends string>(
  id: Id,
  reason: Reason,
) => exposureItem(id, reason, {});

/**
 * One way a preview gateway falls short, as the `preview-gateway` item lists them: previews over
 * plain http beyond loopback, Mend's host under or above the preview domain, Mend's cookies
 * without `__Host-` on a site previews share, previews on a tailnet under `public`, or a published
 * address that isn't the listener's.
 */
export const PreviewProblem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("plain-http"),
    url: Schema.String,
    /** Why plain http is open: the exposure isn't `loopback`, or the listener is reached beyond it. */
    because: Schema.Literals(["exposure-not-loopback", "reached-beyond-loopback"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("domain-overlap"),
    host: Schema.String,
    domain: Schema.String,
    overlap: Schema.Literals(["under", "above"]),
  }),
  Schema.Struct({ kind: Schema.Literal("cookies"), cookie: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tailnet-public") }),
  Schema.Struct({
    kind: Schema.Literal("published-mismatch"),
    listener: Schema.String,
    published: Schema.String,
  }),
]);
export type PreviewProblem = typeof PreviewProblem.Type;

const previewFields = {
  /** Where previews are served: `http://<label>.localhost:4180`, `https://<label>.previews.example`. */
  pattern: Schema.String,
  problems: Schema.Array(PreviewProblem),
  /**
   * What only a look from another network can check (wildcard DNS and certificate, a tailnet's
   * steps, who reaches the gateway): `none` for loopback previews, else stated or not.
   */
  outside: Schema.Literals(["none", "declared", "open"]),
};

/** One item of the public exposure gate as evaluated on this instance (docs/adr/0004). */
export const ExposureGateItem = Schema.Union([
  exposureItem("https-origin", "all-https", { originCount: Schema.Int }),
  exposureItem("https-origin", "plain-origins", { origins: Strings }),
  exposureCase("secure-cookies", "secure"),
  exposureCase("secure-cookies", "app-url-http"),
  exposureItem("trusted-proxies", "ranges", { rangeCount: Schema.Int }),
  exposureCase("trusted-proxies", "unset"),
  exposureCase("trusted-proxies", "trusts-every-address"),
  exposureCase("enrollment-closed", "built-in"),
  exposureCase("tenancy-gate", "complete"),
  exposureItem("tenancy-gate", "missing", { missing: Strings, total: Schema.Int }),
  exposureCase("budgets", "all-set"),
  exposureItem("budgets", "off", { variables: Strings }),
  exposureCase("no-bearers-in-urls", "refused"),
  exposureCase("no-bearers-in-urls", "accepted"),
  exposureCase("browser-headers", "built-in"),
  exposureCase("error-redaction", "redacted"),
  exposureCase("error-redaction", "verbose"),
  exposureCase("executor-channel-transport", "socket"),
  exposureCase("executor-channel-transport", "https"),
  exposureCase("executor-channel-transport", "plain-http-private"),
  exposureCase("executor-channel-transport", "plain-http"),
  exposureCase("workspace-ssh", "unpublished"),
  exposureItem("workspace-ssh", "loopback", { published: Schema.String }),
  exposureItem("workspace-ssh", "published", { published: Schema.String }),
  exposureItem("core-private", "outside-view", { mirrors: Strings }),
  exposureCase("edge-tls", "outside-view"),
  exposureCase("t3code-gateway", "not-said"),
  exposureItem("t3code-gateway", "edge", { published: Schema.String, url: Schema.String }),
  exposureItem("t3code-gateway", "loopback", { published: Schema.String }),
  exposureItem("t3code-gateway", "published", { published: Schema.String }),
  exposureItem("preview-gateway", "loopback-http", previewFields),
  exposureItem("preview-gateway", "domain-https", {
    ...previewFields,
    domain: Schema.String,
    /** The registrable domain Mend's host shares with the previews, or null when it is apart. */
    sharedSite: Schema.NullOr(Schema.String),
  }),
  exposureItem("preview-gateway", "tailnet-https", { ...previewFields, hostname: Schema.String }),
  exposureItem("reassessment", "reviewed", { version: Schema.String }),
  exposureItem("reassessment", "none", { version: Schema.String }),
  exposureItem("reassessment", "older", { version: Schema.String, reviewed: Schema.String }),
  exposureCase("reassessment", "unversioned"),
]);
export type ExposureGateItem = typeof ExposureGateItem.Type;

/** An exposure gate item's case and its data, without what every item has. */
export type ExposureCase = CaseOf<ExposureGateItem, keyof typeof exposureFields>;

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
    // `multi` only: an account of another organization joins this one too, without a link.
    HttpApiEndpoint.post("addMember", "/operator/organizations/:id/members", {
      params: Schema.Struct({ id: OrganizationId }),
      payload: OrganizationMemberRequest,
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
  .middleware(OperatorPersonCredentialOnly)
  .middleware(AuthMiddleware);
