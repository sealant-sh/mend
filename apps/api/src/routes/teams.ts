import {
  CurrentUser,
  InviteSpent,
  MendApi,
  NotFound,
  TeamDetail,
  TeamInviteCreated,
  TeamInvitePreview,
  TeamRejected,
  TeamView,
} from "@mend/api-contracts";
import { ProjectsRepo, TeamsRepo, UsersRepo, type TeamMembership } from "@mend/db";
import type { TeamId } from "@mend/domain";
import {
  TEAM_INVITE_DEFAULT_DAYS,
  TEAM_INVITE_MAX_DAYS,
  teamNameIssue,
  type TeamRole,
} from "@mend/domain/workbench";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/** The path a browser opens to accept an invite; the web app owns the route. */
export const inviteJoinPath = (token: string) => `/join/${token}`;

const toView = (membership: TeamMembership): TeamView =>
  new TeamView({
    team: membership.team,
    role: membership.role,
    memberCount: membership.memberCount,
    projectCount: membership.projectCount,
  });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Teams (docs/adr/0002-teams-and-project-scope.md). A team the caller does not belong to is
 * `NotFound`; owner-only actions from a member are `NotFound` too, so the API never confirms a
 * team exists to someone outside it, and never tells a member what they are not allowed to do
 * beyond what the UI already hides.
 */
export const TeamsGroupLive = HttpApiBuilder.group(MendApi, "teams", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const teams = yield* TeamsRepo;
        return (yield* teams.listForUser(caller.user.id)).map(toView);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const teams = yield* TeamsRepo;
        const issue = teamNameIssue(payload.name);
        if (issue !== null) return yield* new TeamRejected({ message: issue });
        const team = yield* teams
          .create(payload.name, caller.user.id)
          .pipe(
            Effect.catchTag("TeamNameTakenError", (error) =>
              Effect.fail(
                new TeamRejected({ message: `A team named "${error.name}" already exists.` }),
              ),
            ),
          );
        return new TeamView({ team, role: "owner", memberCount: 1, projectCount: 0 });
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const { team, role } = yield* memberOf(params.id);
        const teams = yield* TeamsRepo;
        const projects = yield* ProjectsRepo;
        const members = yield* teams.members(team.id);
        // Invites carry an email and an issuer; only owners, who can mint and revoke them, see
        // the list. Members get an empty array rather than a second endpoint.
        const invites = role === "owner" ? yield* teams.listInvites(team.id) : [];
        return new TeamDetail({
          team,
          role,
          members,
          invites,
          projects: yield* projects.listForTeam(team.id),
        });
      }),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* ownerOf(params.id);
        const teams = yield* TeamsRepo;
        const issue = teamNameIssue(payload.name);
        if (issue !== null) return yield* new TeamRejected({ message: issue });
        yield* teams.rename(params.id, payload.name).pipe(
          Effect.catchTag("TeamNotFoundError", () => Effect.fail(new NotFound({ id: params.id }))),
          Effect.catchTag("TeamNameTakenError", (error) =>
            Effect.fail(
              new TeamRejected({ message: `A team named "${error.name}" already exists.` }),
            ),
          ),
        );
        return yield* viewOf(params.id);
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        yield* ownerOf(params.id);
        const teams = yield* TeamsRepo;
        yield* teams.remove(params.id).pipe(
          Effect.catchTag("TeamNotFoundError", () => Effect.fail(new NotFound({ id: params.id }))),
          Effect.catchTag("TeamHasProjectsError", (error) =>
            Effect.fail(
              new TeamRejected({
                message: `${error.projects.length === 1 ? "A project is" : `${error.projects.length} projects are`} still scoped to this team (${error.projects.join(", ")}). Move them to another scope first.`,
              }),
            ),
          ),
        );
        return { removed: true };
      }),
    )
    .handle("addMember", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        yield* ownerOf(params.id);
        const users = yield* UsersRepo;
        const teams = yield* TeamsRepo;
        const account = yield* users.byEmail(payload.email);
        if (account === null) {
          return yield* new TeamRejected({
            message: `No account on this Mend has the email ${payload.email.trim()}. Send an invite link instead — it works before the account exists.`,
          });
        }
        return yield* teams.addMember(params.id, account.id, payload.role, caller.user.id).pipe(
          Effect.catchTag("TeamNotFoundError", () => Effect.fail(new NotFound({ id: params.id }))),
          Effect.catchTag("TeamMemberExistsError", () =>
            Effect.fail(
              new TeamRejected({ message: `${account.name} is already a member of this team.` }),
            ),
          ),
        );
      }),
    )
    .handle("setRole", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* ownerOf(params.id);
        const teams = yield* TeamsRepo;
        return yield* teams.setRole(params.id, params.userId, payload.role).pipe(
          Effect.catchTag("TeamMemberNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.userId })),
          ),
          Effect.catchTag("TeamLastOwnerError", () =>
            Effect.fail(
              new TeamRejected({
                message: "A team keeps at least one owner. Make someone else an owner first.",
              }),
            ),
          ),
        );
      }),
    )
    .handle("removeMember", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        // Owners remove anyone; a member removes only their own seat (leaves).
        const { role } = yield* memberOf(params.id);
        if (role !== "owner" && params.userId !== caller.user.id) {
          return yield* new NotFound({ id: params.userId });
        }
        const teams = yield* TeamsRepo;
        yield* teams.removeMember(params.id, params.userId).pipe(
          Effect.catchTag("TeamMemberNotFoundError", () =>
            Effect.fail(new NotFound({ id: params.userId })),
          ),
          Effect.catchTag("TeamLastOwnerError", () =>
            Effect.fail(
              new TeamRejected({
                message:
                  params.userId === caller.user.id
                    ? "You are the last owner. Make someone else an owner before leaving."
                    : "A team keeps at least one owner. Make someone else an owner first.",
              }),
            ),
          ),
        );
        return { removed: true };
      }),
    )
    .handle("createInvite", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        yield* ownerOf(params.id);
        const teams = yield* TeamsRepo;
        const email = payload.email?.trim() ?? "";
        if (email !== "" && !email.includes("@")) {
          return yield* new TeamRejected({ message: `"${email}" is not an email address.` });
        }
        const requestedDays = payload.expiresInDays ?? TEAM_INVITE_DEFAULT_DAYS;
        if (requestedDays < 1) {
          return yield* new TeamRejected({ message: "An invite lasts at least one day." });
        }
        const days = Math.min(requestedDays, TEAM_INVITE_MAX_DAYS);
        const minted = yield* teams
          .createInvite({
            teamId: params.id,
            role: payload.role,
            email: email === "" ? null : email,
            createdBy: caller.user.id,
            expiresAt: new Date(Date.now() + days * DAY_MS),
          })
          .pipe(
            Effect.catchTag("TeamNotFoundError", () =>
              Effect.fail(new NotFound({ id: params.id })),
            ),
          );
        return new TeamInviteCreated({
          invite: minted.invite,
          token: minted.token,
          path: inviteJoinPath(minted.token),
        });
      }),
    )
    .handle("revokeInvite", ({ params }) =>
      Effect.gen(function* () {
        yield* ownerOf(params.id);
        const teams = yield* TeamsRepo;
        return yield* teams
          .revokeInvite(params.id, params.inviteId)
          .pipe(
            Effect.catchTag("TeamInviteUnknownError", () =>
              Effect.fail(new NotFound({ id: params.inviteId })),
            ),
          );
      }),
    )
    .handle("invitePreview", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const teams = yield* TeamsRepo;
        const users = yield* UsersRepo;
        const resolved = yield* teams
          .inviteByToken(params.token)
          .pipe(
            Effect.catchTag("TeamInviteUnknownError", () =>
              Effect.fail(new NotFound({ id: "invite" })),
            ),
          );
        const inviter =
          resolved.invite.createdBy === null ? null : yield* users.byId(resolved.invite.createdBy);
        const seat = yield* teams.roleOf(resolved.team.id, caller.user.id);
        return new TeamInvitePreview({
          teamName: resolved.team.name,
          role: resolved.invite.role,
          invitedBy: inviter?.name ?? null,
          expiresAt: resolved.invite.expiresAt,
          state: resolved.state,
          alreadyMember: seat !== null,
          boundEmail: resolved.invite.email,
        });
      }),
    )
    .handle("acceptInvite", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const teams = yield* TeamsRepo;
        const accepted = yield* teams
          .acceptInvite(params.token, { id: caller.user.id, email: caller.user.email })
          .pipe(
            Effect.catchTag("TeamInviteUnknownError", () =>
              Effect.fail(new NotFound({ id: "invite" })),
            ),
            Effect.catchTag("TeamInviteSpentError", (error) =>
              Effect.fail(new InviteSpent({ state: error.state })),
            ),
            Effect.catchTag("TeamInviteNotForYouError", (error) =>
              Effect.fail(
                new TeamRejected({
                  message: `This invite is for ${error.email}; you are signed in as ${caller.user.email}.`,
                }),
              ),
            ),
          );
        return yield* viewOf(accepted.team.id);
      }),
    ),
);

/** The team and the caller's seat in it; no seat reads as no team. */
const memberOf = Effect.fn("Teams.memberOf")(function* (teamId: TeamId) {
  const caller = yield* CurrentUser;
  const teams = yield* TeamsRepo;
  const role = yield* teams.roleOf(teamId, caller.user.id);
  if (role === null) return yield* new NotFound({ id: teamId });
  const team = yield* teams
    .byId(teamId)
    .pipe(Effect.catchTag("TeamNotFoundError", () => Effect.fail(new NotFound({ id: teamId }))));
  return { team, role };
});

/** Owner-only actions: a member's attempt reads exactly like an outsider's. */
const ownerOf = Effect.fn("Teams.ownerOf")(function* (teamId: TeamId) {
  const seat = yield* memberOf(teamId);
  const role: TeamRole = seat.role;
  if (role !== "owner") return yield* new NotFound({ id: teamId });
  return seat;
});

/** The caller's list entry for one team — the shape every mutation answers with. */
const viewOf = Effect.fn("Teams.viewOf")(function* (teamId: TeamId) {
  const caller = yield* CurrentUser;
  const teams = yield* TeamsRepo;
  const entry = (yield* teams.listForUser(caller.user.id)).find(
    (membership) => membership.team.id === teamId,
  );
  if (entry === undefined) return yield* new NotFound({ id: teamId });
  return toView(entry);
});
