import { createHash, randomBytes } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { InvitationId, OrganizationId } from "@mend/domain";
import {
  Invitation,
  Organization,
  OrganizationMember,
  invitationState,
  type InvitationState,
  type OrganizationRole,
} from "@mend/domain/workbench";
import { and, asc, count, desc, eq, ne, sql as rawSql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  instanceRoles,
  organizationInvitations,
  organizationMembers,
  organizations,
} from "../schema/workbench.ts";
import { isUniqueViolation } from "./unique-violation.ts";

export class OrganizationNotFoundError extends Schema.TaggedErrorClass<OrganizationNotFoundError>()(
  "OrganizationNotFoundError",
  { organizationId: Schema.String },
) {}

/** Another organization on this instance already has that name. */
export class OrganizationNameTakenError extends Schema.TaggedErrorClass<OrganizationNameTakenError>()(
  "OrganizationNameTakenError",
  { name: Schema.String },
) {}

/** The change would leave the organization with no owner. */
export class LastOwnerError extends Schema.TaggedErrorClass<LastOwnerError>()("LastOwnerError", {
  organizationId: Schema.String,
}) {}

/** The account is not a member of the organization. */
export class MemberNotFoundError extends Schema.TaggedErrorClass<MemberNotFoundError>()(
  "MemberNotFoundError",
  { organizationId: Schema.String, userId: Schema.String },
) {}

/** An account belongs to exactly one organization, and this one already belongs to one. */
export class AlreadyInOrganizationError extends Schema.TaggedErrorClass<AlreadyInOrganizationError>()(
  "AlreadyInOrganizationError",
  { userId: Schema.String, organizationId: Schema.String },
) {}

/** No invitation matches that token (or that id within the organization). */
export class InvitationUnknownError extends Schema.TaggedErrorClass<InvitationUnknownError>()(
  "InvitationUnknownError",
  {},
) {}

/** The invitation exists but cannot be used any more. */
export class InvitationSpentError extends Schema.TaggedErrorClass<InvitationSpentError>()(
  "InvitationSpentError",
  { state: Schema.Literals(["accepted", "revoked", "expired"]) },
) {}

/**
 * The invitation is bound to a different email. The bound address is deliberately not carried:
 * whoever holds the link must not learn who it was meant for.
 */
export class InvitationNotForYouError extends Schema.TaggedErrorClass<InvitationNotForYouError>()(
  "InvitationNotForYouError",
  {},
) {}

/** A single-organization operation found zero or several organizations. */
export class NotSoleOrganizationError extends Schema.TaggedErrorClass<NotSoleOrganizationError>()(
  "NotSoleOrganizationError",
  { count: Schema.Number },
) {}

/** The caller's organization and role: the input to every authorization decision. */
export interface OrganizationMembership {
  readonly organization: Organization;
  readonly role: OrganizationRole;
  readonly joinedAt: Date;
}

export interface NewInvitation {
  readonly organizationId: OrganizationId;
  readonly role: OrganizationRole;
  readonly email: string | null;
  readonly createdByUserId: string;
  readonly expiresAt: Date;
}

/** An invitation as minted: the row plus the one-time token that is never stored. */
export interface MintedInvitation {
  readonly invitation: Invitation;
  readonly token: string;
}

/** An invitation resolved by its token: the row, its organization, and what it can do now. */
export interface ResolvedInvitation {
  readonly invitation: Invitation;
  readonly organization: Organization;
  readonly state: InvitationState;
}

/**
 * Organizations, memberships and invitations (docs/adr/0003-organizations-and-tenancy.md). Every
 * mutation that could leave an organization without an owner runs under a transaction-scoped
 * advisory lock on that organization, so two concurrent demotions cannot both see "another owner
 * remains". The unique `user_id` on memberships is the one-organization-per-account rule.
 */
export class OrganizationsRepo extends Context.Service<
  OrganizationsRepo,
  {
    readonly count: () => Effect.Effect<number>;
    /** The only organization; `MEND_TENANCY=single` operations and bootstrap use it. */
    readonly sole: () => Effect.Effect<Organization, NotSoleOrganizationError>;
    readonly byId: (id: OrganizationId) => Effect.Effect<Organization, OrganizationNotFoundError>;
    /** Create an organization with no members; the operator invites its first owner. */
    readonly create: (
      name: string,
      createdByUserId: string | null,
    ) => Effect.Effect<Organization, OrganizationNameTakenError>;
    readonly rename: (
      id: OrganizationId,
      name: string,
    ) => Effect.Effect<Organization, OrganizationNotFoundError | OrganizationNameTakenError>;
    /** The account's organization and role, or null when it belongs to none. */
    readonly membershipOf: (userId: string) => Effect.Effect<OrganizationMembership | null>;
    readonly roleOf: (
      organizationId: OrganizationId,
      userId: string,
    ) => Effect.Effect<OrganizationRole | null>;
    /** The roster with each account's public facts: owners first, then by name. */
    readonly members: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<OrganizationMember>>;
    readonly memberCount: (organizationId: OrganizationId) => Effect.Effect<number>;
    readonly addMember: (
      organizationId: OrganizationId,
      userId: string,
      role: OrganizationRole,
      addedByUserId: string | null,
    ) => Effect.Effect<OrganizationMember, OrganizationNotFoundError | AlreadyInOrganizationError>;
    readonly setRole: (
      organizationId: OrganizationId,
      userId: string,
      role: OrganizationRole,
    ) => Effect.Effect<OrganizationMember, MemberNotFoundError | LastOwnerError>;
    /**
     * Remove the membership. Deactivating the account, closing its connections and stopping its
     * sessions are the member-removal service's job; this is only the row, under the owner lock.
     */
    readonly removeMember: (
      organizationId: OrganizationId,
      userId: string,
    ) => Effect.Effect<void, MemberNotFoundError | LastOwnerError>;
    readonly createInvitation: (
      invitation: NewInvitation,
    ) => Effect.Effect<MintedInvitation, OrganizationNotFoundError>;
    /** Every invitation of the organization, newest first, spent ones included. */
    readonly listInvitations: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<Invitation>>;
    readonly revokeInvitation: (
      organizationId: OrganizationId,
      invitationId: InvitationId,
    ) => Effect.Effect<Invitation, InvitationUnknownError | InvitationSpentError>;
    readonly invitationByToken: (
      token: string,
    ) => Effect.Effect<ResolvedInvitation, InvitationUnknownError>;
    /**
     * Spend the invitation. An account with no membership joins; a member of the same
     * organization is promoted by an owner invitation and otherwise keeps its role; an account in
     * another organization is refused.
     */
    readonly acceptInvitation: (
      token: string,
      user: { readonly id: string; readonly email: string },
    ) => Effect.Effect<
      { readonly organization: Organization; readonly member: OrganizationMember },
      | InvitationUnknownError
      | InvitationSpentError
      | InvitationNotForYouError
      | AlreadyInOrganizationError
    >;
    /**
     * Make the account owner of the sole organization and the operator, when nobody holds either
     * yet. Serialized by an advisory lock, so two first registrations racing produce one owner;
     * the loser stays a membership-less account that sees nothing.
     */
    readonly bootstrapFirstAccount: (userId: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/OrganizationsRepo") {}

const toOrganization = (row: typeof organizations.$inferSelect): Organization =>
  new Organization(row);
const toInvitation = (row: typeof organizationInvitations.$inferSelect): Invitation =>
  new Invitation(row);

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const nameTaken =
  (name: string) =>
  (error: { readonly cause: unknown }): Effect.Effect<never, OrganizationNameTakenError> =>
    isUniqueViolation(error)
      ? Effect.fail(new OrganizationNameTakenError({ name: name.trim() }))
      : Effect.die(error);

const decodeMember = Schema.decodeUnknownSync(OrganizationMember);

/** The query surface shared by the root client and a transaction handle. */
type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete" | "execute">;

const lockOrganization = (tx: Tx, organizationId: OrganizationId) =>
  tx
    .execute(
      rawSql`select pg_advisory_xact_lock(hashtext(${`mend:organization:${organizationId}`}))`,
    )
    .pipe(Effect.orDie);

/** Under the organization lock: whether owners other than `userId` remain. */
const otherOwnerRemains = (tx: Tx, organizationId: OrganizationId, userId: string) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({ owners: count() })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.role, "owner"),
          ne(organizationMembers.userId, userId),
        ),
      )
      .pipe(Effect.orDie);
    return (row?.owners ?? 0) > 0;
  });

const roleIn = (tx: Tx, organizationId: OrganizationId, userId: string) =>
  Effect.gen(function* () {
    const [row] = yield* tx
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);
    return row?.role ?? null;
  });

export const OrganizationsRepoLive: Layer.Layer<
  OrganizationsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  OrganizationsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const announce = (organizationId: OrganizationId) =>
      notifyEvent(sql, { type: "organization", organizationId });

    /** One membership joined with the account's facts; null when there is none. */
    const memberRow = Effect.fn("OrganizationsRepo.memberRow")(function* (
      organizationId: OrganizationId,
      userId: string,
    ) {
      const rows = yield* sql`
        SELECT m.organization_id AS "organizationId", m.user_id AS "userId", u.name, u.email,
               m.role, m.created_at AS "joinedAt"
          FROM organization_members m
          JOIN "user" u ON u.id = m.user_id
         WHERE m.organization_id = ${organizationId} AND m.user_id = ${userId}
         LIMIT 1`.pipe(Effect.orDie);
      return rows[0] === undefined ? null : decodeMember(rows[0]);
    });

    const countOrganizations = Effect.fn("OrganizationsRepo.count")(function* () {
      const [row] = yield* db.select({ total: count() }).from(organizations).pipe(Effect.orDie);
      return row?.total ?? 0;
    });

    const sole = Effect.fn("OrganizationsRepo.sole")(function* () {
      const rows = yield* db
        .select()
        .from(organizations)
        .orderBy(asc(organizations.createdAt), asc(organizations.id))
        .limit(2)
        .pipe(Effect.orDie);
      const [only] = rows;
      if (rows.length !== 1 || only === undefined) {
        return yield* new NotSoleOrganizationError({ count: yield* countOrganizations() });
      }
      return toOrganization(only);
    });

    const byId = Effect.fn("OrganizationsRepo.byId")(function* (id: OrganizationId) {
      const [row] = yield* db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new OrganizationNotFoundError({ organizationId: id });
      return toOrganization(row);
    });

    const create = Effect.fn("OrganizationsRepo.create")(function* (
      name: string,
      createdByUserId: string | null,
    ) {
      const [row] = yield* db
        .insert(organizations)
        .values({
          id: OrganizationId.make(crypto.randomUUID()),
          name: name.trim(),
          createdByUserId,
        })
        .returning()
        .pipe(Effect.catchTag("EffectDrizzleQueryError", nameTaken(name)));
      if (row === undefined) return yield* Effect.die("organization insert returned no row");
      const created = toOrganization(row);
      yield* announce(created.id);
      return created;
    });

    const rename = Effect.fn("OrganizationsRepo.rename")(function* (
      id: OrganizationId,
      name: string,
    ) {
      const [row] = yield* db
        .update(organizations)
        .set({ name: name.trim(), updatedAt: new Date() })
        .where(eq(organizations.id, id))
        .returning()
        .pipe(Effect.catchTag("EffectDrizzleQueryError", nameTaken(name)));
      if (row === undefined) return yield* new OrganizationNotFoundError({ organizationId: id });
      yield* announce(id);
      return toOrganization(row);
    });

    const membershipOf = Effect.fn("OrganizationsRepo.membershipOf")(function* (userId: string) {
      const [row] = yield* db
        .select({
          organization: organizations,
          role: organizationMembers.role,
          joinedAt: organizationMembers.createdAt,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(eq(organizationMembers.userId, userId))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return null;
      const membership: OrganizationMembership = {
        organization: toOrganization(row.organization),
        role: row.role,
        joinedAt: row.joinedAt,
      };
      return membership;
    });

    const roleOf = Effect.fn("OrganizationsRepo.roleOf")(function* (
      organizationId: OrganizationId,
      userId: string,
    ) {
      return yield* roleIn(db, organizationId, userId);
    });

    const members = Effect.fn("OrganizationsRepo.members")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* sql`
        SELECT m.organization_id AS "organizationId", m.user_id AS "userId", u.name, u.email,
               m.role, m.created_at AS "joinedAt"
          FROM organization_members m
          JOIN "user" u ON u.id = m.user_id
         WHERE m.organization_id = ${organizationId}
         ORDER BY (m.role = 'owner') DESC, lower(u.name) ASC, m.created_at ASC`.pipe(Effect.orDie);
      return rows.map((row) => decodeMember(row));
    });

    const memberCount = Effect.fn("OrganizationsRepo.memberCount")(function* (
      organizationId: OrganizationId,
    ) {
      const [row] = yield* db
        .select({ total: count() })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId))
        .pipe(Effect.orDie);
      return row?.total ?? 0;
    });

    const alreadyIn = (userId: string) =>
      Effect.gen(function* () {
        const existing = yield* membershipOf(userId);
        return new AlreadyInOrganizationError({
          userId,
          organizationId: existing?.organization.id ?? "",
        });
      });

    const addMember = Effect.fn("OrganizationsRepo.addMember")(function* (
      organizationId: OrganizationId,
      userId: string,
      role: OrganizationRole,
      addedByUserId: string | null,
    ) {
      yield* byId(organizationId);
      const inserted = yield* db
        .insert(organizationMembers)
        .values({ organizationId, userId, role, addedByUserId })
        .pipe(
          Effect.as(true),
          Effect.catchTag("EffectDrizzleQueryError", (error) =>
            isUniqueViolation(error) ? Effect.succeed(false) : Effect.die(error),
          ),
        );
      if (!inserted) {
        const refusal = yield* alreadyIn(userId);
        return yield* refusal;
      }
      const member = yield* memberRow(organizationId, userId);
      if (member === null) return yield* Effect.die("membership insert left no row");
      yield* announce(organizationId);
      return member;
    });

    const setRole = Effect.fn("OrganizationsRepo.setRole")(function* (
      organizationId: OrganizationId,
      userId: string,
      role: OrganizationRole,
    ) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockOrganization(tx, organizationId);
            const current = yield* roleIn(tx, organizationId, userId);
            if (current === null) {
              return yield* new MemberNotFoundError({ organizationId, userId });
            }
            if (
              current === "owner" &&
              role === "member" &&
              !(yield* otherOwnerRemains(tx, organizationId, userId))
            ) {
              return yield* new LastOwnerError({ organizationId });
            }
            yield* tx
              .update(organizationMembers)
              .set({ role })
              .where(
                and(
                  eq(organizationMembers.organizationId, organizationId),
                  eq(organizationMembers.userId, userId),
                ),
              )
              .pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      const member = yield* memberRow(organizationId, userId);
      if (member === null) return yield* new MemberNotFoundError({ organizationId, userId });
      yield* announce(organizationId);
      return member;
    });

    const removeMember = Effect.fn("OrganizationsRepo.removeMember")(function* (
      organizationId: OrganizationId,
      userId: string,
    ) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockOrganization(tx, organizationId);
            const current = yield* roleIn(tx, organizationId, userId);
            if (current === null) {
              return yield* new MemberNotFoundError({ organizationId, userId });
            }
            if (current === "owner" && !(yield* otherOwnerRemains(tx, organizationId, userId))) {
              return yield* new LastOwnerError({ organizationId });
            }
            yield* tx
              .delete(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.organizationId, organizationId),
                  eq(organizationMembers.userId, userId),
                ),
              )
              .pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* announce(organizationId);
    });

    const createInvitation = Effect.fn("OrganizationsRepo.createInvitation")(function* (
      invitation: NewInvitation,
    ) {
      yield* byId(invitation.organizationId);
      // 32 random bytes, url-safe: the link is the whole secret.
      const token = randomBytes(32).toString("base64url");
      const [row] = yield* db
        .insert(organizationInvitations)
        .values({
          id: InvitationId.make(crypto.randomUUID()),
          organizationId: invitation.organizationId,
          tokenHash: hashToken(token),
          role: invitation.role,
          email: invitation.email === null ? null : invitation.email.trim().toLowerCase(),
          createdByUserId: invitation.createdByUserId,
          expiresAt: invitation.expiresAt,
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("invitation insert returned no row");
      yield* announce(invitation.organizationId);
      const minted: MintedInvitation = { invitation: toInvitation(row), token };
      return minted;
    });

    const listInvitations = Effect.fn("OrganizationsRepo.listInvitations")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* db
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.organizationId, organizationId))
        .orderBy(desc(organizationInvitations.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toInvitation);
    });

    const revokeInvitation = Effect.fn("OrganizationsRepo.revokeInvitation")(function* (
      organizationId: OrganizationId,
      invitationId: InvitationId,
    ) {
      const [existing] = yield* db
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, organizationId),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      if (existing === undefined) return yield* new InvitationUnknownError();
      if (existing.acceptedAt !== null) {
        return yield* new InvitationSpentError({ state: "accepted" });
      }
      if (existing.revokedAt !== null) return toInvitation(existing);
      const [row] = yield* db
        .update(organizationInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            rawSql`${organizationInvitations.acceptedAt} IS NULL`,
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new InvitationSpentError({ state: "accepted" });
      yield* announce(organizationId);
      return toInvitation(row);
    });

    const invitationByToken = Effect.fn("OrganizationsRepo.invitationByToken")(function* (
      token: string,
    ) {
      const [row] = yield* db
        .select({ invitation: organizationInvitations, organization: organizations })
        .from(organizationInvitations)
        .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
        .where(eq(organizationInvitations.tokenHash, hashToken(token)))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new InvitationUnknownError();
      const invitation = toInvitation(row.invitation);
      const resolved: ResolvedInvitation = {
        invitation,
        organization: toOrganization(row.organization),
        state: invitationState(invitation, new Date()),
      };
      return resolved;
    });

    const acceptInvitation = Effect.fn("OrganizationsRepo.acceptInvitation")(function* (
      token: string,
      user: { readonly id: string; readonly email: string },
    ) {
      const organizationId = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .select()
              .from(organizationInvitations)
              .where(eq(organizationInvitations.tokenHash, hashToken(token)))
              .limit(1)
              .for("update")
              .pipe(Effect.orDie);
            if (row === undefined) return yield* new InvitationUnknownError();
            const state = invitationState(row, new Date());
            if (state !== "open") return yield* new InvitationSpentError({ state });
            if (row.email !== null && row.email !== user.email.trim().toLowerCase()) {
              return yield* new InvitationNotForYouError();
            }
            yield* lockOrganization(tx, row.organizationId);
            const [existing] = yield* tx
              .select({
                organizationId: organizationMembers.organizationId,
                role: organizationMembers.role,
              })
              .from(organizationMembers)
              .where(eq(organizationMembers.userId, user.id))
              .limit(1)
              .pipe(Effect.orDie);
            if (existing === undefined) {
              yield* tx
                .insert(organizationMembers)
                .values({
                  organizationId: row.organizationId,
                  userId: user.id,
                  role: row.role,
                  addedByUserId: row.createdByUserId,
                })
                .pipe(Effect.orDie);
            } else if (existing.organizationId !== row.organizationId) {
              return yield* new AlreadyInOrganizationError({
                userId: user.id,
                organizationId: existing.organizationId,
              });
            } else if (existing.role === "member" && row.role === "owner") {
              yield* tx
                .update(organizationMembers)
                .set({ role: "owner" })
                .where(
                  and(
                    eq(organizationMembers.organizationId, row.organizationId),
                    eq(organizationMembers.userId, user.id),
                  ),
                )
                .pipe(Effect.orDie);
            }
            yield* tx
              .update(organizationInvitations)
              .set({ acceptedByUserId: user.id, acceptedAt: new Date() })
              .where(eq(organizationInvitations.id, row.id))
              .pipe(Effect.orDie);
            return row.organizationId;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      const organization = yield* byId(organizationId).pipe(Effect.orDie);
      const member = yield* memberRow(organizationId, user.id);
      if (member === null) return yield* Effect.die("accepted invitation left no membership");
      yield* announce(organizationId);
      return { organization, member };
    });

    const bootstrapFirstAccount = Effect.fn("OrganizationsRepo.bootstrapFirstAccount")(function* (
      userId: string,
    ) {
      const organization = yield* sole().pipe(Effect.orDie);
      const bootstrapped = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .execute(rawSql`select pg_advisory_xact_lock(hashtext('mend:bootstrap'))`)
              .pipe(Effect.orDie);
            const [memberships] = yield* tx
              .select({ total: count() })
              .from(organizationMembers)
              .pipe(Effect.orDie);
            const [roles] = yield* tx
              .select({ total: count() })
              .from(instanceRoles)
              .pipe(Effect.orDie);
            if ((memberships?.total ?? 0) > 0 || (roles?.total ?? 0) > 0) return false;
            yield* tx
              .insert(organizationMembers)
              .values({ organizationId: organization.id, userId, role: "owner" })
              .pipe(Effect.orDie);
            yield* tx.insert(instanceRoles).values({ userId, role: "operator" }).pipe(Effect.orDie);
            return true;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      if (bootstrapped) yield* announce(organization.id);
      return bootstrapped;
    });

    return {
      count: countOrganizations,
      sole,
      byId,
      create,
      rename,
      membershipOf,
      roleOf,
      members,
      memberCount,
      addMember,
      setRole,
      removeMember,
      createInvitation,
      listInvitations,
      revokeInvitation,
      invitationByToken,
      acceptInvitation,
      bootstrapFirstAccount,
    };
  }),
);
