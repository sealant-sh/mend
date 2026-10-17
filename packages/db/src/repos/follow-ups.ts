import {
  FollowUpId,
  type ChangeId,
  type CheckpointId,
  type ReviewCommentId,
  type ReviewSliceId,
  type SealantRunId,
  type SessionId,
  type SessionProcessId,
} from "@mend/domain";
import { type DiffDigest, FollowUp } from "@mend/domain/workbench";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { followUps } from "../schema/workbench.ts";

export class FollowUpNotFoundError extends Schema.TaggedErrorClass<FollowUpNotFoundError>()(
  "FollowUpNotFoundError",
  {
    sessionId: Schema.String,
  },
) {}

export interface NewFollowUpBundle {
  readonly sessionId: SessionId;
  readonly changeId: ChangeId;
  readonly reviewSliceId: ReviewSliceId;
  readonly checkpointAId: CheckpointId;
  readonly checkpointBId: CheckpointId;
  readonly diffDigest: DiffDigest;
  readonly commentIds: ReadonlyArray<ReviewCommentId>;
  readonly instruction: string;
  readonly idempotencyKey: string;
}

/** Internal launch ownership; the public FollowUp exposes state, not the server lease token. */
export interface FollowUpDeliveryAttempt {
  readonly followUp: FollowUp;
  readonly attemptId: string | null;
  readonly leaseExpiresAt: Date | null;
}

class FollowUpLockBodyError<E> {
  readonly error: E;

  constructor(error: E) {
    this.error = error;
  }
}

/**
 * Durable Review delivery bundles. The row is written before process launch,
 * then correlated to the accepted process so a retry can finish either side
 * of a server crash without launching twice.
 */
export class FollowUpsRepo extends Context.Service<
  FollowUpsRepo,
  {
    readonly createOrGet: (input: NewFollowUpBundle) => Effect.Effect<FollowUp>;
    readonly withSessionLock: <A, E, R>(
      sessionId: SessionId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly byId: (id: FollowUpId) => Effect.Effect<FollowUp | null>;
    readonly byIdempotencyKey: (
      sessionId: SessionId,
      key: string,
    ) => Effect.Effect<FollowUp | null>;
    readonly activeForSession: (sessionId: SessionId) => Effect.Effect<FollowUp | null>;
    readonly deliveringForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<FollowUpDeliveryAttempt | null>;
    readonly attemptForFollowUp: (id: FollowUpId) => Effect.Effect<FollowUpDeliveryAttempt | null>;
    readonly markPending: (id: FollowUpId) => Effect.Effect<FollowUp>;
    /** Atomically owns one launch attempt. Null means another caller changed the bundle first. */
    readonly claimDelivery: (
      id: FollowUpId,
      attemptId: string,
      leaseExpiresAt: Date,
    ) => Effect.Effect<FollowUpDeliveryAttempt | null>;
    /** Renews only the current attempt; false means ownership has already moved or finalized. */
    readonly renewClaim: (
      id: FollowUpId,
      attemptId: string,
      leaseExpiresAt: Date,
    ) => Effect.Effect<boolean>;
    /** Releases only the attempt identified by its committed token. */
    readonly releaseClaim: (
      id: FollowUpId,
      attemptId: string,
      outcome:
        | { readonly status: "pending" }
        | { readonly status: "delivery_failed"; readonly message: string },
    ) => Effect.Effect<FollowUp | null>;
    /** Process correlation is stronger evidence than an intermediate delivery status. */
    readonly reconcileDelivered: (
      id: FollowUpId,
      processId: SessionProcessId,
      sealantRunId: SealantRunId,
    ) => Effect.Effect<FollowUp>;
  }
>()("@mend/db/FollowUpsRepo") {}

const toFollowUp = (row: typeof followUps.$inferSelect): FollowUp => new FollowUp(row);

const toDeliveryAttempt = (row: typeof followUps.$inferSelect): FollowUpDeliveryAttempt => ({
  followUp: toFollowUp(row),
  attemptId: row.deliveryAttemptId,
  leaseExpiresAt: row.deliveryLeaseExpiresAt,
});

export const FollowUpsRepoLive: Layer.Layer<FollowUpsRepo, never, MendDB> = Layer.effect(
  FollowUpsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const byId = Effect.fn("FollowUpsRepo.byId")(function* (id: FollowUpId) {
      const [row] = yield* db
        .select()
        .from(followUps)
        .where(eq(followUps.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toFollowUp(row);
    });

    const byIdempotencyKey = Effect.fn("FollowUpsRepo.byIdempotencyKey")(function* (
      sessionId: SessionId,
      key: string,
    ) {
      const [row] = yield* db
        .select()
        .from(followUps)
        .where(and(eq(followUps.sessionId, sessionId), eq(followUps.idempotencyKey, key)))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toFollowUp(row);
    });

    const withSessionLock = <A, E, R>(
      sessionId: SessionId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:follow-up:${sessionId}`}))`,
            );
            return yield* effect.pipe(Effect.mapError((error) => new FollowUpLockBodyError(error)));
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof FollowUpLockBodyError ? Effect.fail(error.error) : Effect.die(error),
          ),
        );

    const createOrGet = Effect.fn("FollowUpsRepo.createOrGet")(function* (
      input: NewFollowUpBundle,
    ) {
      const existing = yield* byIdempotencyKey(input.sessionId, input.idempotencyKey);
      if (existing !== null) return existing;
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(followUps)
              .set({ status: "superseded" })
              .where(
                and(
                  eq(followUps.sessionId, input.sessionId),
                  inArray(followUps.status, ["pending", "delivery_failed"]),
                ),
              );
            const [created] = yield* tx
              .insert(followUps)
              .values({
                id: FollowUpId.make(crypto.randomUUID()),
                ...input,
              })
              .returning();
            if (created === undefined) return yield* Effect.die("follow-up insert returned no row");
            return toFollowUp(created);
          }),
        )
        .pipe(Effect.orDie);
    });

    const activeForSession = Effect.fn("FollowUpsRepo.activeForSession")(function* (
      sessionId: SessionId,
    ) {
      const [row] = yield* db
        .select()
        .from(followUps)
        .where(
          and(
            eq(followUps.sessionId, sessionId),
            inArray(followUps.status, ["pending", "delivering", "delivery_failed"]),
          ),
        )
        .orderBy(desc(followUps.createdAt))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toFollowUp(row);
    });

    const deliveringForSession = Effect.fn("FollowUpsRepo.deliveringForSession")(function* (
      sessionId: SessionId,
    ) {
      const [row] = yield* db
        .select()
        .from(followUps)
        .where(and(eq(followUps.sessionId, sessionId), eq(followUps.status, "delivering")))
        .orderBy(desc(followUps.deliveryStartedAt))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toDeliveryAttempt(row);
    });

    const attemptForFollowUp = Effect.fn("FollowUpsRepo.attemptForFollowUp")(function* (
      id: FollowUpId,
    ) {
      const [row] = yield* db
        .select()
        .from(followUps)
        .where(eq(followUps.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toDeliveryAttempt(row);
    });

    const updateStatus = Effect.fn("FollowUpsRepo.updateStatus")(function* (
      id: FollowUpId,
      values: Partial<typeof followUps.$inferInsert>,
    ) {
      const [row] = yield* db
        .update(followUps)
        .set(values)
        .where(eq(followUps.id, id))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die(`follow-up ${id} disappeared during update`);
      return toFollowUp(row);
    });

    const markPending = (id: FollowUpId) =>
      updateStatus(id, {
        status: "pending",
        deliveryError: null,
        deliveryStartedAt: null,
        deliveryAttemptId: null,
        deliveryLeaseExpiresAt: null,
      });

    const claimDelivery = Effect.fn("FollowUpsRepo.claimDelivery")(function* (
      id: FollowUpId,
      attemptId: string,
      leaseExpiresAt: Date,
    ) {
      const [row] = yield* db
        .update(followUps)
        .set({
          status: "delivering",
          deliveryError: null,
          deliveryStartedAt: yield* DateTime.nowAsDate,
          deliveryAttemptId: attemptId,
          deliveryLeaseExpiresAt: leaseExpiresAt,
        })
        .where(and(eq(followUps.id, id), inArray(followUps.status, ["pending", "delivery_failed"])))
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toDeliveryAttempt(row);
    });

    const renewClaim = Effect.fn("FollowUpsRepo.renewClaim")(function* (
      id: FollowUpId,
      attemptId: string,
      leaseExpiresAt: Date,
    ) {
      const rows = yield* db
        .update(followUps)
        .set({ deliveryLeaseExpiresAt: leaseExpiresAt })
        .where(
          and(
            eq(followUps.id, id),
            eq(followUps.status, "delivering"),
            eq(followUps.deliveryAttemptId, attemptId),
          ),
        )
        .returning({ id: followUps.id })
        .pipe(Effect.orDie);
      return rows.length === 1;
    });

    const releaseClaim = Effect.fn("FollowUpsRepo.releaseClaim")(function* (
      id: FollowUpId,
      attemptId: string,
      outcome:
        | { readonly status: "pending" }
        | { readonly status: "delivery_failed"; readonly message: string },
    ) {
      const [row] = yield* db
        .update(followUps)
        .set(
          outcome.status === "pending"
            ? {
                status: "pending",
                deliveryError: null,
                deliveryStartedAt: null,
                deliveryAttemptId: null,
                deliveryLeaseExpiresAt: null,
              }
            : {
                status: "delivery_failed",
                deliveryError: outcome.message,
                deliveryAttemptId: null,
                deliveryLeaseExpiresAt: null,
              },
        )
        .where(
          and(
            eq(followUps.id, id),
            eq(followUps.status, "delivering"),
            eq(followUps.deliveryAttemptId, attemptId),
          ),
        )
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toFollowUp(row);
    });

    const reconcileDelivered = Effect.fn("FollowUpsRepo.reconcileDelivered")(function* (
      id: FollowUpId,
      processId: SessionProcessId,
      sealantRunId: SealantRunId,
    ) {
      return yield* updateStatus(id, {
        status: "delivered",
        deliveryProcessId: processId,
        deliverySealantRunId: sealantRunId,
        deliveryError: null,
        deliveryAttemptId: null,
        deliveryLeaseExpiresAt: null,
        deliveredAt: yield* DateTime.nowAsDate,
      });
    });

    return {
      createOrGet,
      withSessionLock,
      byId,
      byIdempotencyKey,
      activeForSession,
      deliveringForSession,
      attemptForFollowUp,
      markPending,
      claimDelivery,
      renewClaim,
      releaseClaim,
      reconcileDelivered,
    };
  }),
);
