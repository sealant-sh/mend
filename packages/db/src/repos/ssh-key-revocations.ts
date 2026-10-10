import type { OrganizationId } from "@mend/domain";
import { asc, eq, inArray, lte, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sshKeyRevocations } from "../schema/workbench.ts";

/** The workspace SSH keys Mend still owes one removed member (docs/WORKSPACE-SSH.md). */
export interface SshKeyRevocation {
  readonly userId: string;
  readonly organizationId: OrganizationId;
  /** The owner who removed them. */
  readonly actorUserId: string;
  readonly requestedAt: Date;
  /** Attempts made and deferred so far. */
  readonly attempts: number;
  /** Keys still active after the last attempt; null while they could not be read. */
  readonly outstanding: number | null;
  readonly lastError: string | null;
}

/**
 * Pending revocations. `OrganizationsRepo.removeMember` writes a row with the membership's
 * deletion; the worker's sweep claims due rows, archives the person's keys, and settles a row once
 * the platform holds none of theirs active.
 */
export class SshKeyRevocationsRepo extends Context.Service<
  SshKeyRevocationsRepo,
  {
    /** Every row, oldest first: what Mend still owes. */
    readonly list: () => Effect.Effect<ReadonlyArray<SshKeyRevocation>>;
    /**
     * Take up to `limit` rows whose next attempt is due and hold each off for `leaseMs`, in one
     * statement (`FOR UPDATE SKIP LOCKED`), so two workers never attempt the same person at once.
     */
    readonly claimDue: (
      limit: number,
      leaseMs: number,
    ) => Effect.Effect<ReadonlyArray<SshKeyRevocation>>;
    /** No key of theirs is active: nothing is owed. */
    readonly settle: (userId: string) => Effect.Effect<void>;
    /** Some keys are still active (or unread): try again after `retryInMs`. */
    readonly defer: (
      userId: string,
      input: {
        readonly outstanding: number | null;
        readonly lastError: string;
        readonly retryInMs: number;
      },
    ) => Effect.Effect<void>;
  }
>()("@mend/db/SshKeyRevocationsRepo") {}

const toRevocation = (row: typeof sshKeyRevocations.$inferSelect): SshKeyRevocation => ({
  userId: row.userId,
  organizationId: row.organizationId,
  actorUserId: row.actorUserId,
  requestedAt: row.requestedAt,
  attempts: row.attempts,
  outstanding: row.outstanding,
  lastError: row.lastError,
});

export const SshKeyRevocationsRepoLive: Layer.Layer<SshKeyRevocationsRepo, never, MendDB> =
  Layer.effect(
    SshKeyRevocationsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const list = Effect.fn("SshKeyRevocationsRepo.list")(function* () {
        const rows = yield* db
          .select()
          .from(sshKeyRevocations)
          .orderBy(asc(sshKeyRevocations.requestedAt))
          .pipe(Effect.orDie);
        return rows.map(toRevocation);
      });

      const claimDue = Effect.fn("SshKeyRevocationsRepo.claimDue")(function* (
        limit: number,
        leaseMs: number,
      ) {
        const due = db
          .select({ userId: sshKeyRevocations.userId })
          .from(sshKeyRevocations)
          .where(lte(sshKeyRevocations.nextAttemptAt, sql`now()`))
          .orderBy(asc(sshKeyRevocations.nextAttemptAt))
          .limit(limit)
          .for("update", { skipLocked: true });
        const rows = yield* db
          .update(sshKeyRevocations)
          .set({ nextAttemptAt: new Date(Date.now() + leaseMs) })
          .where(inArray(sshKeyRevocations.userId, due))
          .returning()
          .pipe(Effect.orDie);
        return rows.map(toRevocation);
      });

      const settle = Effect.fn("SshKeyRevocationsRepo.settle")(function* (userId: string) {
        yield* db
          .delete(sshKeyRevocations)
          .where(eq(sshKeyRevocations.userId, userId))
          .pipe(Effect.orDie);
      });

      const defer = Effect.fn("SshKeyRevocationsRepo.defer")(function* (
        userId: string,
        input: {
          readonly outstanding: number | null;
          readonly lastError: string;
          readonly retryInMs: number;
        },
      ) {
        yield* db
          .update(sshKeyRevocations)
          .set({
            attempts: sql`${sshKeyRevocations.attempts} + 1`,
            outstanding: input.outstanding,
            lastError: input.lastError,
            nextAttemptAt: new Date(Date.now() + input.retryInMs),
          })
          .where(eq(sshKeyRevocations.userId, userId))
          .pipe(Effect.orDie);
      });

      return { list, claimDue, settle, defer };
    }),
  );
