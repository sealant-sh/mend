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
import { and, asc, count, desc, eq, gt, isNull, ne, or, sql as rawSql } from "drizzle-orm";
import { Clock, DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  credentialOrganizations,
  deviceTokens,
  instanceRoles,
  organizationInvitations,
  organizationMembers,
  organizations,
  sshKeyRevocations,
} from "../schema/workbench.ts";
import { isForeignKeyViolation, isUniqueViolation } from "./unique-violation.ts";
import type { TicketCredential } from "./upgrade-tickets.ts";

export class OrganizationNotFoundError extends Schema.TaggedError<OrganizationNotFoundError>()(
  "OrganizationNotFoundError",
  { organizationId: Schema.String },
) {}

/** Another organization on this instance already has that name. */
export class OrganizationNameTakenError extends Schema.TaggedError<OrganizationNameTakenError>()(
  "OrganizationNameTakenError",
  { name: Schema.String },
) {}

/** The change would leave the organization with no owner. */
export class LastOwnerError extends Schema.TaggedError<LastOwnerError>()("LastOwnerError", {
  organizationId: Schema.String,
}) {}

/** The account is not a member of the organization. */
export class MemberNotFoundError extends Schema.TaggedError<MemberNotFoundError>()(
  "MemberNotFoundError",
  { organizationId: Schema.String, userId: Schema.String },
) {}

/** An access key acts in its own organization and never switches (docs/adr/0023, decision 3). */
export class AccessKeyCannotSwitchError extends Schema.TaggedError<AccessKeyCannotSwitchError>()(
  "AccessKeyCannotSwitchError",
  { credential: Schema.String },
) {}

/** The account is already a member of that organization. */
export class AlreadyInOrganizationError extends Schema.TaggedError<AlreadyInOrganizationError>()(
  "AlreadyInOrganizationError",
  { userId: Schema.String, organizationId: Schema.String },
) {}

/** No invitation matches that token (or that id within the organization). */
export class InvitationUnknownError extends Schema.TaggedError<InvitationUnknownError>()(
  "InvitationUnknownError",
  {},
) {}

/** The invitation exists but cannot be used any more. */
export class InvitationSpentError extends Schema.TaggedError<InvitationSpentError>()(
  "InvitationSpentError",
  { state: Schema.Literals(["accepted", "revoked", "expired"]) },
) {}

/**
 * The invitation is bound to a different email. The bound address is deliberately not carried:
 * whoever holds the link must not learn who it was meant for.
 */
export class InvitationNotForYouError extends Schema.TaggedError<InvitationNotForYouError>()(
  "InvitationNotForYouError",
  {},
) {}

/** A single-organization operation found zero or several organizations. */
export class NotSoleOrganizationError extends Schema.TaggedError<NotSoleOrganizationError>()(
  "NotSoleOrganizationError",
  { count: Schema.Number },
) {}

/** One organization of an account and its role there: the input to every authorization decision. */
export interface OrganizationMembership {
  readonly organization: Organization;
  readonly role: OrganizationRole;
  readonly joinedAt: Date;
}

/**
 * One way an account signs in: a sign-in or paired device (`session:<id>`, `device:<id>`), which
 * acts in its pinned organization; an access key (`key:<id>`), which acts in its key row's and is
 * never pinned (docs/adr/0023, decision 3); or null for a bearer with no row (the dev token),
 * which keeps no organization of its own.
 */
export interface SignIn {
  readonly userId: string;
  readonly credential: TicketCredential | null;
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
 * remains". An account may belong to several organizations; each sign-in acts in one of them
 * (`activeMembership`), and every other read names the organization it asks about.
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
    /**
     * Every organization of the account, in the order a sign-in with no pin chooses from: the one
     * switched to last, then the oldest membership.
     */
    readonly memberships: (userId: string) => Effect.Effect<ReadonlyArray<OrganizationMembership>>;
    /** The account's membership of one organization, or null when it is not a member. */
    readonly membershipIn: (
      organizationId: OrganizationId,
      userId: string,
    ) => Effect.Effect<OrganizationMembership | null>;
    /**
     * The organization this sign-in acts in: its pin, or else the first of `memberships`, which
     * is then pinned so the sign-in stays there when the account switches elsewhere. Null when
     * the account belongs to none.
     */
    readonly activeMembership: (signIn: SignIn) => Effect.Effect<OrganizationMembership | null>;
    /**
     * Pin this sign-in to one of the account's organizations and make it the one a new sign-in
     * starts in. Idempotent. A sign-in that held another organization is announced, so every
     * process closes the connections it opened there.
     */
    readonly switchActive: (
      signIn: SignIn,
      organizationId: OrganizationId,
    ) => Effect.Effect<OrganizationMembership, MemberNotFoundError | AccessKeyCannotSwitchError>;
    readonly roleOf: (
      organizationId: OrganizationId,
      userId: string,
    ) => Effect.Effect<OrganizationRole | null>;
    /** The roster with each account's public facts: owners first, then by name. */
    readonly members: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<OrganizationMember>>;
    readonly memberCount: (organizationId: OrganizationId) => Effect.Effect<number>;
    /** Every organization with its member and owner counts, by name: the operator's list. */
    readonly listWithCounts: () => Effect.Effect<
      ReadonlyArray<{
        readonly organization: Organization;
        readonly memberCount: number;
        readonly ownerCount: number;
      }>
    >;
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
     * sessions are the member-removal service's job; this is only the row, under the owner lock,
     * and, in the same transaction when it was the account's last organization, the workspace SSH
     * key revocation the removal owes (`ssh_key_revocations`), held off for `revocationLease`
     * while the remover makes the first attempt itself. Answers the obligation's id, which fences
     * that attempt, or null when the account still belongs to another organization.
     */
    readonly removeMember: (
      organizationId: OrganizationId,
      userId: string,
      revocation: { readonly actorUserId: string; readonly revocationLeaseMs: number },
    ) => Effect.Effect<
      { readonly revocationId: string | null },
      MemberNotFoundError | LastOwnerError
    >;
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
     * Spend the invitation. An account that is not a member of its organization joins it, whatever
     * other organizations it belongs to; a member of the same organization is promoted by an owner
     * invitation and otherwise keeps its role.
     */
    readonly acceptInvitation: (
      token: string,
      user: { readonly id: string; readonly email: string },
    ) => Effect.Effect<
      { readonly organization: Organization; readonly member: OrganizationMember },
      InvitationUnknownError | InvitationSpentError | InvitationNotForYouError
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

/**
 * Remove the guarded membership without publishing an event. When it was the account's last
 * organization, record its SSH cleanup debt and answer true; workspace SSH keys belong to the
 * account, so an account that remains in another organization keeps them.
 */
export const deleteMembership = Effect.fn("OrganizationsRepo.deleteMembership")(function* (
  tx: Tx,
  organizationId: OrganizationId,
  userId: string,
  revocation: { readonly id: string; readonly actorUserId: string; readonly leaseMs: number },
) {
  yield* lockOrganization(tx, organizationId);
  // Two removals of one account from two organizations each hold only their own lock; this
  // one makes them count what remains one after the other.
  yield* tx
    .execute(rawSql`select pg_advisory_xact_lock(hashtext(${`mend:account:${userId}`}))`)
    .pipe(Effect.orDie);
  const current = yield* roleIn(tx, organizationId, userId);
  if (current === null) return yield* new MemberNotFoundError({ organizationId, userId });
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
  const [left] = yield* tx
    .select({ total: count() })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .pipe(Effect.orDie);
  if ((left?.total ?? 0) > 0) return false;
  const owed = {
    id: revocation.id,
    organizationId,
    actorUserId: revocation.actorUserId,
    requestedAt: yield* DateTime.nowAsDate,
    attempts: 0,
    nextAttemptAt: new Date((yield* Clock.currentTimeMillis) + revocation.leaseMs),
    outstanding: null,
    lastError: null,
  };
  yield* tx
    .insert(sshKeyRevocations)
    .values({ userId, ...owed })
    .onConflictDoUpdate({ target: sshKeyRevocations.userId, set: owed })
    .pipe(Effect.orDie);
  return true;
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
        .set({ name: name.trim(), updatedAt: yield* DateTime.nowAsDate })
        .where(eq(organizations.id, id))
        .returning()
        .pipe(Effect.catchTag("EffectDrizzleQueryError", nameTaken(name)));
      if (row === undefined) return yield* new OrganizationNotFoundError({ organizationId: id });
      yield* announce(id);
      return toOrganization(row);
    });

    const membershipColumns = {
      organization: organizations,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    };
    const toMembership = (row: {
      readonly organization: typeof organizations.$inferSelect;
      readonly role: OrganizationRole;
      readonly joinedAt: Date;
    }): OrganizationMembership => ({
      organization: toOrganization(row.organization),
      role: row.role,
      joinedAt: row.joinedAt,
    });

    const memberships = Effect.fn("OrganizationsRepo.memberships")(function* (userId: string) {
      const rows = yield* db
        .select(membershipColumns)
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(eq(organizationMembers.userId, userId))
        .orderBy(
          rawSql`${organizationMembers.lastChosenAt} DESC NULLS LAST`,
          asc(organizationMembers.createdAt),
          asc(organizationMembers.organizationId),
        )
        .pipe(Effect.orDie);
      return rows.map(toMembership);
    });

    const membershipIn = Effect.fn("OrganizationsRepo.membershipIn")(function* (
      organizationId: OrganizationId,
      userId: string,
    ) {
      const [row] = yield* db
        .select(membershipColumns)
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toMembership(row);
    });

    const pinned = (userId: string, credential: string) =>
      db
        .select(membershipColumns)
        .from(credentialOrganizations)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, credentialOrganizations.organizationId),
            eq(organizationMembers.userId, credentialOrganizations.userId),
          ),
        )
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(
          and(
            eq(credentialOrganizations.credential, credential),
            eq(credentialOrganizations.userId, userId),
          ),
        )
        .limit(1)
        .pipe(
          Effect.orDie,
          Effect.map(([row]) => (row === undefined ? null : toMembership(row))),
        );

    // The membership in the organization a live key was created in, or null once its person left.
    const keyMembership = Effect.fn("OrganizationsRepo.keyMembership")(function* (
      userId: string,
      keyId: string,
    ) {
      const now = yield* DateTime.nowAsDate;
      const [row] = yield* db
        .select(membershipColumns)
        .from(deviceTokens)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, deviceTokens.organizationId),
            eq(organizationMembers.userId, deviceTokens.userId),
          ),
        )
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(
          and(
            eq(deviceTokens.id, keyId),
            eq(deviceTokens.kind, "access_key"),
            eq(deviceTokens.userId, userId),
            isNull(deviceTokens.revokedAt),
            or(isNull(deviceTokens.expiresAt), gt(deviceTokens.expiresAt, now)),
          ),
        )
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toMembership(row);
    });

    const activeMembership = Effect.fn("OrganizationsRepo.activeMembership")(function* (
      signIn: SignIn,
    ) {
      const { userId, credential } = signIn;
      if (credential?.startsWith("key:") === true) {
        return yield* keyMembership(userId, credential.slice("key:".length));
      }
      if (credential !== null) {
        const held = yield* pinned(userId, credential);
        if (held !== null) return held;
      }
      const [first] = yield* memberships(userId);
      if (first === undefined || credential === null) return first ?? null;
      // A concurrent pin wins (DO NOTHING); a membership removed meanwhile refuses the pin (FK).
      yield* db
        .insert(credentialOrganizations)
        .values({ credential, userId, organizationId: first.organization.id })
        .onConflictDoNothing({ target: credentialOrganizations.credential })
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) =>
            isForeignKeyViolation(error) ? Effect.void : Effect.die(error),
          ),
        );
      return (yield* pinned(userId, credential)) ?? (yield* memberships(userId))[0] ?? null;
    });

    const switchActive = Effect.fn("OrganizationsRepo.switchActive")(function* (
      signIn: SignIn,
      organizationId: OrganizationId,
    ) {
      const { userId, credential } = signIn;
      if (credential?.startsWith("key:") === true) {
        return yield* new AccessKeyCannotSwitchError({ credential });
      }
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [chosen] = yield* tx
              .update(organizationMembers)
              .set({ lastChosenAt: yield* DateTime.nowAsDate })
              .where(
                and(
                  eq(organizationMembers.organizationId, organizationId),
                  eq(organizationMembers.userId, userId),
                ),
              )
              .returning({ userId: organizationMembers.userId })
              .pipe(Effect.orDie);
            if (chosen === undefined) {
              return yield* new MemberNotFoundError({ organizationId, userId });
            }
            if (credential === null) return;
            const [before] = yield* tx
              .select({ organizationId: credentialOrganizations.organizationId })
              .from(credentialOrganizations)
              .where(eq(credentialOrganizations.credential, credential))
              .for("update")
              .pipe(Effect.orDie);
            if (before?.organizationId === organizationId) return;
            yield* tx
              .insert(credentialOrganizations)
              .values({ credential, userId, organizationId })
              .onConflictDoUpdate({
                target: credentialOrganizations.credential,
                set: { userId, organizationId, chosenAt: yield* DateTime.nowAsDate },
              })
              .pipe(Effect.orDie);
            // Rides the transaction: delivered at commit, so no process closes before the pin moved.
            yield* notifyEvent(sql, { type: "sign-in-organization", userId, credential });
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      const membership = yield* membershipIn(organizationId, userId);
      if (membership === null) return yield* new MemberNotFoundError({ organizationId, userId });
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

    const listWithCounts = Effect.fn("OrganizationsRepo.listWithCounts")(function* () {
      const rows = yield* db
        .select()
        .from(organizations)
        .orderBy(asc(organizations.name))
        .pipe(Effect.orDie);
      const counts = yield* db
        .select({
          organizationId: organizationMembers.organizationId,
          role: organizationMembers.role,
          total: count(),
        })
        .from(organizationMembers)
        .groupBy(organizationMembers.organizationId, organizationMembers.role)
        .pipe(Effect.orDie);
      const totalOf = (organizationId: OrganizationId, role?: OrganizationRole) =>
        counts
          .filter(
            (entry) =>
              entry.organizationId === organizationId &&
              (role === undefined || entry.role === role),
          )
          .reduce((sum, entry) => sum + entry.total, 0);
      return rows.map((row) => ({
        organization: toOrganization(row),
        memberCount: totalOf(row.id),
        ownerCount: totalOf(row.id, "owner"),
      }));
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
      if (!inserted) return yield* new AlreadyInOrganizationError({ userId, organizationId });
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
      revocation: { readonly actorUserId: string; readonly revocationLeaseMs: number },
    ) {
      const revocationId = crypto.randomUUID();
      const owed = yield* db
        .transaction((tx) =>
          deleteMembership(tx, organizationId, userId, {
            id: revocationId,
            actorUserId: revocation.actorUserId,
            leaseMs: revocation.revocationLeaseMs,
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
      yield* announce(organizationId);
      return { revocationId: owed ? revocationId : null };
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
        .set({ revokedAt: yield* DateTime.nowAsDate })
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
        state: invitationState(invitation, yield* DateTime.nowAsDate),
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
            const state = invitationState(row, yield* DateTime.nowAsDate);
            if (state !== "open") return yield* new InvitationSpentError({ state });
            if (row.email !== null && row.email !== user.email.trim().toLowerCase()) {
              return yield* new InvitationNotForYouError();
            }
            yield* lockOrganization(tx, row.organizationId);
            const existing = yield* roleIn(tx, row.organizationId, user.id);
            if (existing === null) {
              yield* tx
                .insert(organizationMembers)
                .values({
                  organizationId: row.organizationId,
                  userId: user.id,
                  role: row.role,
                  addedByUserId: row.createdByUserId,
                })
                .pipe(Effect.orDie);
            } else if (existing === "member" && row.role === "owner") {
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
              .set({ acceptedByUserId: user.id, acceptedAt: yield* DateTime.nowAsDate })
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
      // Bootstrap only exists on an instance with exactly one organization.
      const organization = yield* sole().pipe(
        Effect.catchTag("NotSoleOrganizationError", () => Effect.succeed(null)),
      );
      if (organization === null) return false;
      const bootstrapped = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .execute(rawSql`select pg_advisory_xact_lock(hashtext('mend:bootstrap'))`)
              .pipe(Effect.orDie);
            const [memberRows] = yield* tx
              .select({ total: count() })
              .from(organizationMembers)
              .pipe(Effect.orDie);
            const [roles] = yield* tx
              .select({ total: count() })
              .from(instanceRoles)
              .pipe(Effect.orDie);
            if ((memberRows?.total ?? 0) > 0 || (roles?.total ?? 0) > 0) return false;
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
      listWithCounts,
      sole,
      byId,
      create,
      rename,
      memberships,
      membershipIn,
      activeMembership,
      switchActive,
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
