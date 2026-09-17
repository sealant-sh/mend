import { Schema } from "effect";

import { TeamId, TeamInviteId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A team: a named group of accounts on one instance, and the unit a project is shared with
 * (docs/adr/0002-teams-and-project-scope.md). Owners manage the roster and the team itself;
 * members work in its projects. There is no read-only role — visibility is the working
 * permission everywhere in Mend.
 */
export const TeamRole = Schema.Literals(["owner", "member"]);
export type TeamRole = typeof TeamRole.Type;

export class Team extends Schema.Class<Team>("Team")({
  id: TeamId,
  /** Display name, unique per instance after trimming. */
  name: Schema.String,
  /** The account that created it; null once that account is gone. */
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** One account's seat in a team, with the account's public facts beside it. */
export class TeamMember extends Schema.Class<TeamMember>("TeamMember")({
  teamId: TeamId,
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: TeamRole,
  joinedAt: Timestamp,
}) {}

/**
 * A single-use invitation. The token is shown once when minted; only its sha256 is stored, so the
 * row can say who it was for and whether it was used, never re-issue the link.
 */
export class TeamInvite extends Schema.Class<TeamInvite>("TeamInvite")({
  id: TeamInviteId,
  teamId: TeamId,
  role: TeamRole,
  /** When set, only the account with this email can accept. */
  email: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  acceptedBy: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Timestamp),
  revokedAt: Schema.NullOr(Timestamp),
}) {}

/** What one invite can do right now, as the join page and the roster show it. */
export type TeamInviteState = "open" | "accepted" | "revoked" | "expired";

export const teamInviteState = (
  invite: Pick<TeamInvite, "acceptedAt" | "revokedAt" | "expiresAt">,
  now: Date,
): TeamInviteState => {
  if (invite.acceptedAt !== null) return "accepted";
  if (invite.revokedAt !== null) return "revoked";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
};

export const TEAM_MAX_NAME_LENGTH = 64;
export const TEAM_INVITE_DEFAULT_DAYS = 7;
export const TEAM_INVITE_MAX_DAYS = 30;

/** The caller-visible problem with a team name, or null when it is accepted. */
export const teamNameIssue = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed === "") return "A team needs a name.";
  if (trimmed.length > TEAM_MAX_NAME_LENGTH) {
    return `Team names are at most ${TEAM_MAX_NAME_LENGTH} characters.`;
  }
  if (/[\p{Cc}]/u.test(trimmed)) return "Team names cannot contain control characters.";
  return null;
};
