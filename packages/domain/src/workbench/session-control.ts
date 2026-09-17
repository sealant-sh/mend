import { Schema } from "effect";

import { SessionControlEventId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import type { OrganizationRole } from "./organization.ts";

/**
 * Who did what to a session beyond sending turns (docs/adr/0003-organizations-and-tenancy.md).
 * Turns carry their author and approvals their decider; these are the other steering acts, so a
 * shared session always says who interrupted, attached or stopped it.
 */
export const SessionControlKind = Schema.Literals([
  "interrupt",
  "terminal-attach",
  "shell-open",
  "stop",
  "shared-control-on",
  "shared-control-off",
]);
export type SessionControlKind = typeof SessionControlKind.Type;

export class SessionControlEvent extends Schema.Class<SessionControlEvent>("SessionControlEvent")({
  id: SessionControlEventId,
  sessionId: SessionId,
  actorUserId: Schema.String,
  kind: SessionControlKind,
  /** The turn, process or Service the act concerned, when it concerned one. */
  refId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
}) {}

/** The facts a steering decision reads. */
export interface SteeringFacts {
  readonly ownerUserId: string | null;
  readonly sharedControlEnabledAt: Date | null;
}

/**
 * Steering a session the caller can already see: its owner always, anyone else only while the
 * owner shares control. A session with no owner is steered by nobody.
 */
export const canSteerSession = (session: SteeringFacts, callerUserId: string): boolean =>
  session.ownerUserId !== null &&
  (callerUserId === session.ownerUserId || session.sharedControlEnabledAt !== null);

/**
 * Turning shared control on is the owner's choice alone: it lends their credentials. Turning it
 * off is also open to an organization owner, who can always take back a teammate's session.
 */
export const canToggleSharedControl = (
  session: SteeringFacts,
  caller: { readonly userId: string; readonly role: OrganizationRole },
  enable: boolean,
): boolean =>
  session.ownerUserId !== null &&
  (caller.userId === session.ownerUserId || (!enable && caller.role === "owner"));
