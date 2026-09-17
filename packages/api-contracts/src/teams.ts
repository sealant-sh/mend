import { TeamId, TeamInviteId } from "@mend/domain";
import { Project, Team, TeamInvite, TeamMember, TeamRole } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * Teams and project scope (docs/adr/0002-teams-and-project-scope.md). Every route acts as the
 * signed-in account: a team the account does not belong to reads as 404, never 403, like every
 * other account-scoped row in this API.
 */

/** A request the team rules refuse — the message says which rule. */
export class TeamRejected extends Schema.TaggedErrorClass<TeamRejected>()(
  "TeamRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The invite exists but is spent: accepted, revoked, or past its expiry. */
export class InviteSpent extends Schema.TaggedErrorClass<InviteSpent>()(
  "InviteSpent",
  { state: Schema.Literals(["accepted", "revoked", "expired"]) },
  { httpApiStatus: 409 },
) {}

/** One team as the caller's list shows it: their seat beside the team. */
export class TeamView extends Schema.Class<TeamView>("TeamView")({
  team: Team,
  role: TeamRole,
  memberCount: Schema.Int,
  projectCount: Schema.Int,
}) {}

/** A team opened: roster, invites (owners only — members get an empty list), projects. */
export class TeamDetail extends Schema.Class<TeamDetail>("TeamDetail")({
  team: Team,
  role: TeamRole,
  members: Schema.Array(TeamMember),
  invites: Schema.Array(TeamInvite),
  projects: Schema.Array(Project),
}) {}

export class CreateTeamRequest extends Schema.Class<CreateTeamRequest>("CreateTeamRequest")({
  name: Schema.String,
}) {}

export class RenameTeamRequest extends Schema.Class<RenameTeamRequest>("RenameTeamRequest")({
  name: Schema.String,
}) {}

/** Add an account that already exists on this instance, by its email. */
export class AddTeamMemberRequest extends Schema.Class<AddTeamMemberRequest>(
  "AddTeamMemberRequest",
)({
  email: Schema.String,
  role: TeamRole,
}) {}

export class SetTeamRoleRequest extends Schema.Class<SetTeamRoleRequest>("SetTeamRoleRequest")({
  role: TeamRole,
}) {}

export class CreateTeamInviteRequest extends Schema.Class<CreateTeamInviteRequest>(
  "CreateTeamInviteRequest",
)({
  role: TeamRole,
  /** Bind acceptance to one account's email; omitted means anyone holding the link. */
  email: Schema.optional(Schema.String),
  /** Days until the link stops working; the server clamps to its maximum. */
  expiresInDays: Schema.optional(Schema.Int),
}) {}

/** The one time the token is visible: the row plus the path a browser opens to accept it. */
export class TeamInviteCreated extends Schema.Class<TeamInviteCreated>("TeamInviteCreated")({
  invite: TeamInvite,
  token: Schema.String,
  /** Relative to the web app's origin — the caller knows which host it reached. */
  path: Schema.String,
}) {}

/** What a join link shows before the account accepts it. */
export class TeamInvitePreview extends Schema.Class<TeamInvitePreview>("TeamInvitePreview")({
  teamName: Schema.String,
  role: TeamRole,
  invitedBy: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date,
  state: Schema.Literals(["open", "accepted", "revoked", "expired"]),
  /** Whether the signed-in account already holds a seat in the team. */
  alreadyMember: Schema.Boolean,
  /** The email the invite is bound to, when it is bound; null when anyone may accept. */
  boundEmail: Schema.NullOr(Schema.String),
}) {}

/** Where a project is visible: the owner alone, one team, or everyone on the instance. */
export class ProjectScopeRequest extends Schema.Class<ProjectScopeRequest>("ProjectScopeRequest")({
  kind: Schema.Literals(["personal", "team", "instance"]),
  /** Required when kind is `team`. */
  teamId: Schema.optional(TeamId),
}) {}

export const teamsGroup = HttpApiGroup.make("teams")
  .add(HttpApiEndpoint.get("list", "/teams", { success: Schema.Array(TeamView) }))
  .add(
    HttpApiEndpoint.post("create", "/teams", {
      payload: CreateTeamRequest,
      success: TeamView,
      error: TeamRejected,
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/teams/:id", {
      params: Schema.Struct({ id: TeamId }),
      success: TeamDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("rename", "/teams/:id", {
      params: Schema.Struct({ id: TeamId }),
      payload: RenameTeamRequest,
      success: TeamView,
      error: [NotFound, TeamRejected],
    }),
  )
  .add(
    // Refused while projects are scoped to the team (the message names them).
    HttpApiEndpoint.delete("remove", "/teams/:id", {
      params: Schema.Struct({ id: TeamId }),
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [NotFound, TeamRejected],
    }),
  )
  .add(
    HttpApiEndpoint.post("addMember", "/teams/:id/members", {
      params: Schema.Struct({ id: TeamId }),
      payload: AddTeamMemberRequest,
      success: TeamMember,
      error: [NotFound, TeamRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("setRole", "/teams/:id/members/:userId", {
      params: Schema.Struct({ id: TeamId, userId: Schema.String }),
      payload: SetTeamRoleRequest,
      success: TeamMember,
      error: [NotFound, TeamRejected],
    }),
  )
  .add(
    // An owner removes any seat; any member removes their own (leaves). The last owner cannot.
    HttpApiEndpoint.delete("removeMember", "/teams/:id/members/:userId", {
      params: Schema.Struct({ id: TeamId, userId: Schema.String }),
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [NotFound, TeamRejected],
    }),
  )
  .add(
    HttpApiEndpoint.post("createInvite", "/teams/:id/invites", {
      params: Schema.Struct({ id: TeamId }),
      payload: CreateTeamInviteRequest,
      success: TeamInviteCreated,
      error: [NotFound, TeamRejected],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revokeInvite", "/teams/:id/invites/:inviteId", {
      params: Schema.Struct({ id: TeamId, inviteId: TeamInviteId }),
      success: TeamInvite,
      error: NotFound,
    }),
  )
  .add(
    // The join page: what the link offers, before the account commits.
    HttpApiEndpoint.get("invitePreview", "/invites/:token", {
      params: Schema.Struct({ token: Schema.String }),
      success: TeamInvitePreview,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("acceptInvite", "/invites/:token/accept", {
      params: Schema.Struct({ token: Schema.String }),
      success: TeamView,
      error: [NotFound, InviteSpent, TeamRejected],
    }),
  )
  .middleware(AuthMiddleware);
