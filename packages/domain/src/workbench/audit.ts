import { Schema } from "effect";

import { AuditEventId, OrganizationId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * What an organization's audit log records (docs/adr/0003-organizations-and-tenancy.md): changes to
 * who belongs, who may see what, and what the organization shares. Session activity lives in the
 * session record, not here.
 */
export const AuditAction = Schema.Literals([
  "invitation.created",
  "invitation.revoked",
  "invitation.accepted",
  "member.role_changed",
  "member.removed",
  "project.visibility_changed",
  "project.taken_over",
  "folder.created",
  "folder.removed",
  "reference.added",
  "reference.removed",
  // Mend took a login or token out of the git remotes a server before 0.36 cloned with one
  // (docs/GIT-ACCESS.md, "Credentials in repository URLs"), credited to whoever adopted it.
  "project.remote_credentials_removed",
  "reference.remote_credentials_removed",
  "session.shared_control_on",
  "session.shared_control_off",
  // The owner ended a session's workspace with captures still pending: work was discarded.
  "session.unsaved_discarded",
  // Mend stopped a session whose owner no longer has access to where it ran (mend#558): a removed
  // member, or a joiner who can no longer see the project. The session's owner is the actor.
  "session.stopped_no_access",
  "member.password_reset_issued",
  "organization.created",
  "organization.renamed",
  // An owner changed the defaults every project in the organization inherits.
  "organization.settings_changed",
  "recovery.owner_granted",
  "recovery.password_reset_issued",
  // docs/adr/0006-slack.md, "Audit".
  "slack.installed",
  "slack.replaced",
  "slack.removed",
  "slack.settings_changed",
  "slack.link_created",
  "slack.link_removed",
  "slack.session_started",
  "slack.channel_default_set",
  "slack.channel_default_cleared",
  // docs/adr/0007-landing.md, "What Mend records and shows": the owner's credentials pushed, and
  // `gh` spoke as them.
  "change.landed",
  "change.pull_request_refreshed",
  "change.bundle_downloaded",
  // A pull request opened outside Mend was read with the owner's `gh` and recorded.
  "change.pull_request_adopted",
  // docs/WORKSPACE-SSH.md: a key the workspace SSH gateway accepts for an account was registered,
  // or archived so the gateway refuses it. The subject is the member who holds the key.
  "ssh_key.added",
  "ssh_key.removed",
  // A member was removed and some of their keys are still active (or unread): Mend keeps trying,
  // and each key it archives later is its own `ssh_key.removed`.
  "ssh_key.revocation_pending",
]);
export type AuditAction = typeof AuditAction.Type;

/** Small facts beside an action: the new role, the previous creator, a name. Never secrets. */
export const AuditData = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]),
);
export type AuditData = typeof AuditData.Type;

/** One recorded action: who did what to which subject, and when. */
export class AuditEvent extends Schema.Class<AuditEvent>("AuditEvent")({
  id: AuditEventId,
  organizationId: OrganizationId,
  /** The account that acted. */
  actorUserId: Schema.String,
  action: AuditAction,
  /**
   * What the action touched: `member`, `invitation`, `project`, `session`, `folder`, `reference`,
   * `organization` (its name or defaults), `slack` (the organization's Slack app) or `change` (a
   * landing).
   */
  subjectType: Schema.String,
  subjectId: Schema.String,
  data: AuditData,
  createdAt: Timestamp,
}) {}

/** The most one audit page returns. */
export const AUDIT_PAGE_MAX = 200;
