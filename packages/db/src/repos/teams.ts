import { createHash, randomBytes } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { TeamId, TeamInviteId, Timestamp } from "@mend/domain";
import {
  Team,
  TeamInvite,
  TeamMember,
  teamInviteState,
  type TeamInviteState,
  type TeamRole,
  type TeamStanding,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, sql as rawSql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projects, teamInvites, teamMembers, teams } from "../schema/workbench.ts";

export class TeamNotFoundError extends Schema.TaggedErrorClass<TeamNotFoundError>()(
  "TeamNotFoundError",
  { teamId: Schema.String },
) {}

/** Another team on this instance already has that name. */
export class TeamNameTakenError extends Schema.TaggedErrorClass<TeamNameTakenError>()(
  "TeamNameTakenError",
  { name: Schema.String },
) {}

/** Projects are still scoped to the team; move them out before deleting it. */
export class TeamHasProjectsError extends Schema.TaggedErrorClass<TeamHasProjectsError>()(
  "TeamHasProjectsError",
  { teamId: Schema.String, projects: Schema.Array(Schema.String) },
) {}

/** The change would leave the team with no owner. */
export class TeamLastOwnerError extends Schema.TaggedErrorClass<TeamLastOwnerError>()(
  "TeamLastOwnerError",
  { teamId: Schema.String },
) {}

/** The account already holds a seat in the team. */
export class TeamMemberExistsError extends Schema.TaggedErrorClass<TeamMemberExistsError>()(
  "TeamMemberExistsError",
  { teamId: Schema.String, userId: Schema.String },
) {}

/** The account holds no seat in the team. */
export class TeamMemberNotFoundError extends Schema.TaggedErrorClass<TeamMemberNotFoundError>()(
  "TeamMemberNotFoundError",
  { teamId: Schema.String, userId: Schema.String },
) {}

/** No invite matches that token (or id within the team). */
export class TeamInviteUnknownError extends Schema.TaggedErrorClass<TeamInviteUnknownError>()(
  "TeamInviteUnknownError",
  {},
) {}

/** The invite exists but cannot be accepted any more. */
export class TeamInviteSpentError extends Schema.TaggedErrorClass<TeamInviteSpentError>()(
  "TeamInviteSpentError",
  { state: Schema.Literals(["accepted", "revoked", "expired"]) },
) {}

/** The invite is bound to a different email than the accepting account's. */
export class TeamInviteNotForYouError extends Schema.TaggedErrorClass<TeamInviteNotForYouError>()(
  "TeamInviteNotForYouError",
  { email: Schema.String },
) {}

/** A team as the caller's own list shows it: their seat plus the roster's size. */
export class TeamMembership extends Schema.Class<TeamMembership>("TeamMembership")({
  team: Team,
  role: Schema.Literals(["owner", "member"]),
  memberCount: Schema.Int,
  projectCount: Schema.Int,
  joinedAt: Timestamp,
}) {}

export interface NewTeamInvite {
  readonly teamId: TeamId;
  readonly role: TeamRole;
  readonly email: string | null;
  readonly createdBy: string;
  readonly expiresAt: Date;
}

/** An invite as minted: the row plus the one-time token that is never stored. */
export interface MintedTeamInvite {
  readonly invite: TeamInvite;
  readonly token: string;
}

/** An invite resolved by its token: the row, the team, and what the token can do now. */
export interface ResolvedTeamInvite {
  readonly invite: TeamInvite;
  readonly team: Team;
  readonly state: TeamInviteState;
}

/**
 * Teams, seats, and invites (docs/adr/0002-teams-and-project-scope.md). Every mutation that can
 * leave a team ownerless runs under a transaction-scoped advisory lock on the team, so two
 * concurrent demotions cannot both see "another owner remains".
 */
export class TeamsRepo extends Context.Service<
  TeamsRepo,
  {
    /** Create a team; the creator takes the first owner seat. */
    readonly create: (name: string, createdBy: string) => Effect.Effect<Team, TeamNameTakenError>;
    readonly byId: (id: TeamId) => Effect.Effect<Team, TeamNotFoundError>;
    readonly rename: (
      id: TeamId,
      name: string,
    ) => Effect.Effect<Team, TeamNotFoundError | TeamNameTakenError>;
    /** Delete a team with no projects; seats and invites cascade. */
    readonly remove: (id: TeamId) => Effect.Effect<void, TeamNotFoundError | TeamHasProjectsError>;
    /** The caller's teams, by name. */
    readonly listForUser: (userId: string) => Effect.Effect<ReadonlyArray<TeamMembership>>;
    /** Which teams the account belongs to and owns — the input to every visibility check. */
    readonly standing: (userId: string) => Effect.Effect<TeamStanding>;
    readonly roleOf: (teamId: TeamId, userId: string) => Effect.Effect<TeamRole | null>;
    /** The roster with each account's public facts, owners first then by name. */
    readonly members: (teamId: TeamId) => Effect.Effect<ReadonlyArray<TeamMember>>;
    readonly addMember: (
      teamId: TeamId,
      userId: string,
      role: TeamRole,
      addedBy: string | null,
    ) => Effect.Effect<TeamMember, TeamNotFoundError | TeamMemberExistsError>;
    readonly setRole: (
      teamId: TeamId,
      userId: string,
      role: TeamRole,
    ) => Effect.Effect<TeamMember, TeamMemberNotFoundError | TeamLastOwnerError>;
    readonly removeMember: (
      teamId: TeamId,
      userId: string,
    ) => Effect.Effect<void, TeamMemberNotFoundError | TeamLastOwnerError>;
    readonly createInvite: (
      invite: NewTeamInvite,
    ) => Effect.Effect<MintedTeamInvite, TeamNotFoundError>;
    /** Every invite of the team, newest first — spent ones included so the roster can say so. */
    readonly listInvites: (teamId: TeamId) => Effect.Effect<ReadonlyArray<TeamInvite>>;
    readonly revokeInvite: (
      teamId: TeamId,
      inviteId: TeamInviteId,
    ) => Effect.Effect<TeamInvite, TeamInviteUnknownError>;
    readonly inviteByToken: (
      token: string,
    ) => Effect.Effect<ResolvedTeamInvite, TeamInviteUnknownError>;
    /** Take the seat the invite offers; an existing seat is kept (the higher role wins). */
    readonly acceptInvite: (
      token: string,
      user: { readonly id: string; readonly email: string },
    ) => Effect.Effect<
      { readonly team: Team; readonly member: TeamMember },
      TeamInviteUnknownError | TeamInviteSpentError | TeamInviteNotForYouError
    >;
  }
>()("@mend/db/TeamsRepo") {}

const toTeam = (row: typeof teams.$inferSelect): Team => new Team(row);
const toInvite = (row: typeof teamInvites.$inferSelect): TeamInvite => new TeamInvite(row);

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Postgres unique_violation — the name or hash collided with a live row. The driver error sits
 * below the drizzle error as an Effect `Cause` (its `reasons` carry the effect-sql error, whose
 * `cause` is pg's), so walk causes and reasons alike until a `code` appears.
 */
const isUniqueViolation = (error: unknown, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 8) return false;
  if ("code" in error && error.code === "23505") return true;
  if ("reasons" in error && Array.isArray(error.reasons)) {
    return error.reasons.some((reason: unknown) => isUniqueViolation(reason, depth + 1));
  }
  for (const key of ["cause", "error", "defect"] as const) {
    if (key in error && isUniqueViolation((error as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }
  return false;
};

/** A collided team name becomes the typed failure; any other query error is a defect. */
const nameTaken =
  (name: string) =>
  (error: { readonly cause: unknown }): Effect.Effect<never, TeamNameTakenError> =>
    isUniqueViolation(error)
      ? Effect.fail(new TeamNameTakenError({ name: name.trim() }))
      : Effect.die(error);

const decodeMember = Schema.decodeUnknownSync(TeamMember);

/** The handle `db.transaction` gives its body. */
type Transaction = Parameters<Parameters<MendDatabase["transaction"]>[0]>[0];

/** Under the team lock: whether owners other than `userId` remain. */
const otherOwnerRemains = (tx: Transaction, teamId: TeamId, userId: string) =>
  Effect.gen(function* () {
    yield* tx
      .execute(rawSql`select pg_advisory_xact_lock(hashtext(${`mend:team:${teamId}`}))`)
      .pipe(Effect.orDie);
    const owners = yield* tx
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "owner")))
      .pipe(Effect.orDie);
    return owners.some((owner) => owner.userId !== userId);
  });

export const TeamsRepoLive: Layer.Layer<TeamsRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    TeamsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const sql = yield* PgClient.PgClient;

      const announce = (teamId: TeamId) => notifyEvent(sql, { type: "team", teamId });

      /** One seat joined with the account's facts; null when the account holds none. */
      const memberRow = Effect.fn("TeamsRepo.memberRow")(function* (
        teamId: TeamId,
        userId: string,
      ) {
        const rows = yield* sql`
          SELECT m.team_id AS "teamId", m.user_id AS "userId", u.name, u.email, m.role,
                 m.created_at AS "joinedAt"
            FROM team_members m
            JOIN "user" u ON u.id = m.user_id
           WHERE m.team_id = ${teamId} AND m.user_id = ${userId}
           LIMIT 1`.pipe(Effect.orDie);
        return rows[0] === undefined ? null : decodeMember(rows[0]);
      });

      const create = Effect.fn("TeamsRepo.create")(function* (name: string, createdBy: string) {
        const id = TeamId.make(crypto.randomUUID());
        const created = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [row] = yield* tx
                .insert(teams)
                .values({ id, name: name.trim(), createdBy })
                .returning()
                .pipe(Effect.catchTag("EffectDrizzleQueryError", nameTaken(name)));
              if (row === undefined) return yield* Effect.die("team insert returned no row");
              yield* tx
                .insert(teamMembers)
                .values({ teamId: id, userId: createdBy, role: "owner", addedBy: createdBy })
                .pipe(Effect.orDie);
              return toTeam(row);
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* announce(created.id);
        return created;
      });

      const byId = Effect.fn("TeamsRepo.byId")(function* (id: TeamId) {
        const [row] = yield* db
          .select()
          .from(teams)
          .where(eq(teams.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new TeamNotFoundError({ teamId: id });
        return toTeam(row);
      });

      const rename = Effect.fn("TeamsRepo.rename")(function* (id: TeamId, name: string) {
        const [row] = yield* db
          .update(teams)
          .set({ name: name.trim(), updatedAt: new Date() })
          .where(eq(teams.id, id))
          .returning()
          .pipe(Effect.catchTag("EffectDrizzleQueryError", nameTaken(name)));
        if (row === undefined) return yield* new TeamNotFoundError({ teamId: id });
        yield* announce(id);
        return toTeam(row);
      });

      const remove = Effect.fn("TeamsRepo.remove")(function* (id: TeamId) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .execute(rawSql`select pg_advisory_xact_lock(hashtext(${`mend:team:${id}`}))`)
                .pipe(Effect.orDie);
              const [team] = yield* tx
                .select()
                .from(teams)
                .where(eq(teams.id, id))
                .limit(1)
                .pipe(Effect.orDie);
              if (team === undefined) return yield* new TeamNotFoundError({ teamId: id });
              const scoped = yield* tx
                .select({ name: projects.name })
                .from(projects)
                .where(eq(projects.teamId, id))
                .orderBy(asc(projects.name))
                .pipe(Effect.orDie);
              if (scoped.length > 0) {
                return yield* new TeamHasProjectsError({
                  teamId: id,
                  projects: scoped.map((project) => project.name),
                });
              }
              yield* tx.delete(teams).where(eq(teams.id, id)).pipe(Effect.orDie);
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* announce(id);
      });

      const listForUser = Effect.fn("TeamsRepo.listForUser")(function* (userId: string) {
        const rows = yield* db
          .select({
            team: teams,
            role: teamMembers.role,
            joinedAt: teamMembers.createdAt,
            memberCount: rawSql<number>`(
              SELECT count(*)::int FROM team_members c WHERE c.team_id = ${teams.id})`,
            projectCount: rawSql<number>`(
              SELECT count(*)::int FROM projects p WHERE p.team_id = ${teams.id})`,
          })
          .from(teamMembers)
          .innerJoin(teams, eq(teams.id, teamMembers.teamId))
          .where(eq(teamMembers.userId, userId))
          .orderBy(asc(teams.name))
          .pipe(Effect.orDie);
        return rows.map(
          (row) =>
            new TeamMembership({
              team: toTeam(row.team),
              role: row.role,
              memberCount: row.memberCount,
              projectCount: row.projectCount,
              joinedAt: row.joinedAt,
            }),
        );
      });

      const standing = Effect.fn("TeamsRepo.standing")(function* (userId: string) {
        const rows = yield* db
          .select({ teamId: teamMembers.teamId, role: teamMembers.role })
          .from(teamMembers)
          .where(eq(teamMembers.userId, userId))
          .pipe(Effect.orDie);
        const memberOf = new Set<TeamId>();
        const ownerOf = new Set<TeamId>();
        for (const row of rows) {
          memberOf.add(row.teamId);
          if (row.role === "owner") ownerOf.add(row.teamId);
        }
        const result: TeamStanding = { memberOf, ownerOf };
        return result;
      });

      const roleOf = Effect.fn("TeamsRepo.roleOf")(function* (teamId: TeamId, userId: string) {
        const [row] = yield* db
          .select({ role: teamMembers.role })
          .from(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.role ?? null;
      });

      const members = Effect.fn("TeamsRepo.members")(function* (teamId: TeamId) {
        const rows = yield* sql`
          SELECT m.team_id AS "teamId", m.user_id AS "userId", u.name, u.email, m.role,
                 m.created_at AS "joinedAt"
            FROM team_members m
            JOIN "user" u ON u.id = m.user_id
           WHERE m.team_id = ${teamId}
           ORDER BY (m.role = 'owner') DESC, lower(u.name) ASC, m.created_at ASC`.pipe(
          Effect.orDie,
        );
        return rows.map((row) => decodeMember(row));
      });

      const addMember = Effect.fn("TeamsRepo.addMember")(function* (
        teamId: TeamId,
        userId: string,
        role: TeamRole,
        addedBy: string | null,
      ) {
        yield* byId(teamId);
        yield* db
          .insert(teamMembers)
          .values({ teamId, userId, role, addedBy })
          .pipe(
            Effect.catchTag("EffectDrizzleQueryError", (error) =>
              isUniqueViolation(error)
                ? Effect.fail(new TeamMemberExistsError({ teamId, userId }))
                : Effect.die(error),
            ),
          );
        const member = yield* memberRow(teamId, userId);
        if (member === null) return yield* Effect.die("team member insert left no row");
        yield* announce(teamId);
        return member;
      });

      const setRole = Effect.fn("TeamsRepo.setRole")(function* (
        teamId: TeamId,
        userId: string,
        role: TeamRole,
      ) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (role === "member" && !(yield* otherOwnerRemains(tx, teamId, userId))) {
                // Either this is the last owner, or the account is not a member at all — the
                // second case falls through to the not-found below via the empty update.
                const [seat] = yield* tx
                  .select({ role: teamMembers.role })
                  .from(teamMembers)
                  .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
                  .limit(1)
                  .pipe(Effect.orDie);
                if (seat?.role === "owner") return yield* new TeamLastOwnerError({ teamId });
              }
              const updated = yield* tx
                .update(teamMembers)
                .set({ role })
                .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
                .returning({ userId: teamMembers.userId })
                .pipe(Effect.orDie);
              if (updated.length === 0) {
                return yield* new TeamMemberNotFoundError({ teamId, userId });
              }
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        const member = yield* memberRow(teamId, userId);
        if (member === null) return yield* new TeamMemberNotFoundError({ teamId, userId });
        yield* announce(teamId);
        return member;
      });

      const removeMember = Effect.fn("TeamsRepo.removeMember")(function* (
        teamId: TeamId,
        userId: string,
      ) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const remains = yield* otherOwnerRemains(tx, teamId, userId);
              const [seat] = yield* tx
                .select({ role: teamMembers.role })
                .from(teamMembers)
                .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
                .limit(1)
                .pipe(Effect.orDie);
              if (seat === undefined) return yield* new TeamMemberNotFoundError({ teamId, userId });
              if (seat.role === "owner" && !remains)
                return yield* new TeamLastOwnerError({ teamId });
              yield* tx
                .delete(teamMembers)
                .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
                .pipe(Effect.orDie);
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        yield* announce(teamId);
      });

      const createInvite = Effect.fn("TeamsRepo.createInvite")(function* (invite: NewTeamInvite) {
        yield* byId(invite.teamId);
        // 32 random bytes, url-safe: the link is the whole secret.
        const token = randomBytes(32).toString("base64url");
        const [row] = yield* db
          .insert(teamInvites)
          .values({
            id: TeamInviteId.make(crypto.randomUUID()),
            teamId: invite.teamId,
            tokenHash: hashToken(token),
            role: invite.role,
            email: invite.email === null ? null : invite.email.trim().toLowerCase(),
            createdBy: invite.createdBy,
            expiresAt: invite.expiresAt,
          })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("team invite insert returned no row");
        yield* announce(invite.teamId);
        return { invite: toInvite(row), token };
      });

      const listInvites = Effect.fn("TeamsRepo.listInvites")(function* (teamId: TeamId) {
        const rows = yield* db
          .select()
          .from(teamInvites)
          .where(eq(teamInvites.teamId, teamId))
          .orderBy(desc(teamInvites.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toInvite);
      });

      const revokeInvite = Effect.fn("TeamsRepo.revokeInvite")(function* (
        teamId: TeamId,
        inviteId: TeamInviteId,
      ) {
        const [row] = yield* db
          .update(teamInvites)
          .set({ revokedAt: new Date() })
          .where(and(eq(teamInvites.id, inviteId), eq(teamInvites.teamId, teamId)))
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new TeamInviteUnknownError();
        yield* announce(teamId);
        return toInvite(row);
      });

      const inviteByToken = Effect.fn("TeamsRepo.inviteByToken")(function* (token: string) {
        const [row] = yield* db
          .select({ invite: teamInvites, team: teams })
          .from(teamInvites)
          .innerJoin(teams, eq(teams.id, teamInvites.teamId))
          .where(eq(teamInvites.tokenHash, hashToken(token)))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new TeamInviteUnknownError();
        const invite = toInvite(row.invite);
        return { invite, team: toTeam(row.team), state: teamInviteState(invite, new Date()) };
      });

      const acceptInvite = Effect.fn("TeamsRepo.acceptInvite")(function* (
        token: string,
        user: { readonly id: string; readonly email: string },
      ) {
        const teamId = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [row] = yield* tx
                .select()
                .from(teamInvites)
                .where(eq(teamInvites.tokenHash, hashToken(token)))
                .limit(1)
                .for("update")
                .pipe(Effect.orDie);
              if (row === undefined) return yield* new TeamInviteUnknownError();
              const state = teamInviteState(row, new Date());
              if (state !== "open") return yield* new TeamInviteSpentError({ state });
              if (row.email !== null && row.email !== user.email.trim().toLowerCase()) {
                return yield* new TeamInviteNotForYouError({ email: row.email });
              }
              const [seat] = yield* tx
                .select({ role: teamMembers.role })
                .from(teamMembers)
                .where(and(eq(teamMembers.teamId, row.teamId), eq(teamMembers.userId, user.id)))
                .limit(1)
                .pipe(Effect.orDie);
              if (seat === undefined) {
                yield* tx
                  .insert(teamMembers)
                  .values({
                    teamId: row.teamId,
                    userId: user.id,
                    role: row.role,
                    addedBy: row.createdBy,
                  })
                  .pipe(Effect.orDie);
              } else if (seat.role === "member" && row.role === "owner") {
                yield* tx
                  .update(teamMembers)
                  .set({ role: "owner" })
                  .where(and(eq(teamMembers.teamId, row.teamId), eq(teamMembers.userId, user.id)))
                  .pipe(Effect.orDie);
              }
              yield* tx
                .update(teamInvites)
                .set({ acceptedBy: user.id, acceptedAt: new Date() })
                .where(eq(teamInvites.id, row.id))
                .pipe(Effect.orDie);
              return row.teamId;
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
        const team = yield* byId(teamId).pipe(Effect.orDie);
        const member = yield* memberRow(teamId, user.id);
        if (member === null) return yield* Effect.die("accepted invite left no seat");
        yield* announce(teamId);
        return { team, member };
      });

      return {
        create,
        byId,
        rename,
        remove,
        listForUser,
        standing,
        roleOf,
        members,
        addMember,
        setRole,
        removeMember,
        createInvite,
        listInvites,
        revokeInvite,
        inviteByToken,
        acceptInvite,
      };
    }),
  );
