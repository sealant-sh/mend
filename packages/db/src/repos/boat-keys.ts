import type { OrganizationId } from "@mend/domain";
import type { BoatKeyOwner, BoatLaunchKey } from "@mend/domain/workbench";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { boatKeys } from "../schema/workbench.ts";
import { isUniqueViolation } from "./unique-violation.ts";

/** The owner has a Boat key already: another connect got there first. */
export class BoatKeyTakenError extends Schema.TaggedError<BoatKeyTakenError>()(
  "BoatKeyTakenError",
  { organizationId: Schema.String },
) {}

/** Which sealant Boat account holds an owner's Boat key, and who connected it when. Never the key. */
export interface BoatKey {
  readonly owner: BoatKeyOwner;
  readonly sealantBoatAccountId: string;
  readonly connectedByUserId: string;
  readonly connectedAt: Date;
  readonly keyReplacedAt: Date | null;
}

/** A person in the organization with their own Boat key, and since when. Never its details. */
export interface PersonWithBoatKey {
  readonly userId: string;
  readonly connectedAt: Date;
}

export interface NewBoatKey {
  readonly owner: BoatKeyOwner;
  readonly sealantBoatAccountId: string;
  readonly connectedByUserId: string;
}

/**
 * Boat keys: one per owner, an organization's (SLNT-790) or a person's in one organization
 * (SLNT-797), its key held by sealant as a Boat account.
 */
export class BoatKeysRepo extends Context.Service<
  BoatKeysRepo,
  {
    /**
     * The key a Boat launch in `organizationId` by `userId` names: the person's own key in the
     * organization, else the organization's, else the server's.
     */
    readonly launchKey: (
      organizationId: OrganizationId,
      userId: string | null,
    ) => Effect.Effect<BoatLaunchKey>;
    /** The people in the organization who connected their own key, oldest first. */
    readonly peopleWithKeys: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<PersonWithBoatKey>>;
    readonly byOwner: (owner: BoatKeyOwner) => Effect.Effect<BoatKey | null>;
    readonly connect: (key: NewBoatKey) => Effect.Effect<BoatKey, BoatKeyTakenError>;
    /** Stamps that the owner's key was replaced; the sealant account stays the same. */
    readonly markReplaced: (owner: BoatKeyOwner) => Effect.Effect<BoatKey | null>;
    /** Forgets the owner's key; null when there was none. */
    readonly remove: (owner: BoatKeyOwner) => Effect.Effect<BoatKey | null>;
  }
>()("@mend/db/BoatKeysRepo") {}

const toBoatKey = (row: typeof boatKeys.$inferSelect): BoatKey => ({
  owner:
    row.ownerUserId === null
      ? { kind: "organization", organizationId: row.organizationId }
      : { kind: "person", organizationId: row.organizationId, userId: row.ownerUserId },
  sealantBoatAccountId: row.sealantBoatAccountId,
  connectedByUserId: row.connectedByUserId,
  connectedAt: row.connectedAt,
  keyReplacedAt: row.keyReplacedAt,
});

const ownerIs = (owner: BoatKeyOwner) =>
  and(
    eq(boatKeys.organizationId, owner.organizationId),
    owner.kind === "organization"
      ? isNull(boatKeys.ownerUserId)
      : eq(boatKeys.ownerUserId, owner.userId),
  );

export const BoatKeysRepoLive: Layer.Layer<BoatKeysRepo, never, MendDB> = Layer.effect(
  BoatKeysRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const launchKey = Effect.fn("BoatKeysRepo.launchKey")(function* (
      organizationId: OrganizationId,
      userId: string | null,
    ) {
      const [row] = yield* db
        .select({
          sealantBoatAccountId: boatKeys.sealantBoatAccountId,
          ownerUserId: boatKeys.ownerUserId,
        })
        .from(boatKeys)
        .where(
          and(
            eq(boatKeys.organizationId, organizationId),
            userId === null
              ? isNull(boatKeys.ownerUserId)
              : or(isNull(boatKeys.ownerUserId), eq(boatKeys.ownerUserId, userId)),
          ),
        )
        .orderBy(sql`${boatKeys.ownerUserId} IS NULL`, asc(boatKeys.connectedAt))
        .limit(1)
        .pipe(Effect.orDie);
      const key: BoatLaunchKey =
        row === undefined
          ? { decidedBy: "server", sealantBoatAccountId: null }
          : {
              decidedBy: row.ownerUserId === null ? "organization" : "person",
              sealantBoatAccountId: row.sealantBoatAccountId,
            };
      return key;
    });

    const peopleWithKeys = Effect.fn("BoatKeysRepo.peopleWithKeys")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* db
        .select({ userId: boatKeys.ownerUserId, connectedAt: boatKeys.connectedAt })
        .from(boatKeys)
        .where(and(eq(boatKeys.organizationId, organizationId), isNotNull(boatKeys.ownerUserId)))
        .orderBy(asc(boatKeys.connectedAt))
        .pipe(Effect.orDie);
      return rows.flatMap((row) =>
        row.userId === null ? [] : [{ userId: row.userId, connectedAt: row.connectedAt }],
      );
    });

    const byOwner = Effect.fn("BoatKeysRepo.byOwner")(function* (owner: BoatKeyOwner) {
      const [row] = yield* db
        .select()
        .from(boatKeys)
        .where(ownerIs(owner))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toBoatKey(row);
    });

    const connect = Effect.fn("BoatKeysRepo.connect")(function* (key: NewBoatKey) {
      const [row] = yield* db
        .insert(boatKeys)
        .values({
          id: crypto.randomUUID(),
          organizationId: key.owner.organizationId,
          ownerUserId: key.owner.kind === "person" ? key.owner.userId : null,
          sealantBoatAccountId: key.sealantBoatAccountId,
          connectedByUserId: key.connectedByUserId,
        })
        .returning()
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) =>
            isUniqueViolation(error)
              ? Effect.fail(new BoatKeyTakenError({ organizationId: key.owner.organizationId }))
              : Effect.die(error),
          ),
        );
      if (row === undefined) return yield* Effect.die("boat_keys insert returned no row");
      return toBoatKey(row);
    });

    const markReplaced = Effect.fn("BoatKeysRepo.markReplaced")(function* (owner: BoatKeyOwner) {
      const [row] = yield* db
        .update(boatKeys)
        .set({ keyReplacedAt: yield* DateTime.nowAsDate })
        .where(ownerIs(owner))
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toBoatKey(row);
    });

    const remove = Effect.fn("BoatKeysRepo.remove")(function* (owner: BoatKeyOwner) {
      const [row] = yield* db.delete(boatKeys).where(ownerIs(owner)).returning().pipe(Effect.orDie);
      return row === undefined ? null : toBoatKey(row);
    });

    return BoatKeysRepo.of({
      launchKey,
      peopleWithKeys,
      byOwner,
      connect,
      markReplaced,
      remove,
    });
  }),
);
