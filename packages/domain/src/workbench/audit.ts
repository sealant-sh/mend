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
  "session.shared_control_on",
  "session.shared_control_off",
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
  /** What the action touched: `member`, `invitation`, `project`, `session`, `folder` or `reference`. */
  subjectType: Schema.String,
  subjectId: Schema.String,
  data: AuditData,
  createdAt: Timestamp,
}) {}

/** The most one audit page returns. */
export const AUDIT_PAGE_MAX = 200;
