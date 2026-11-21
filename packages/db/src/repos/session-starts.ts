import type { SessionId } from "@mend/domain";
import { and, eq, isNull, lt } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionStarts } from "../schema/workbench.ts";

/** A start the browser named by its key, as stored. */
export interface SessionStartRow {
  readonly ownerUserId: string;
  readonly key: string;
  /** The session Mend made for it, once made. */
  readonly sessionId: SessionId | null;
  /** Mend's sentence when it could not make the session. */
  readonly failure: string | null;
  readonly createdAt: Date;
}

/**
 * Starts the browser names by a key it chose (SLNT-1239). A key is one person's: two people's
 * starts never meet. Each start is claimed once, then ends once, made or failed.
 */
export class SessionStartsRepo extends Context.Service<
  SessionStartsRepo,
  {
    /** Claim a key for a new start; false when the person used it already. */
    readonly claim: (ownerUserId: string, key: string) => Effect.Effect<boolean>;
    /** The start made its session. */
    readonly made: (ownerUserId: string, key: string, sessionId: SessionId) => Effect.Effect<void>;
    /** The start could not make its session, and why. */
    readonly failed: (ownerUserId: string, key: string, failure: string) => Effect.Effect<void>;
    readonly read: (ownerUserId: string, key: string) => Effect.Effect<SessionStartRow | null>;
    /** Forget starts made before `before`: their sessions carry on alone. */
    readonly forgetBefore: (before: Date) => Effect.Effect<number>;
  }
>()("@mend/db/SessionStartsRepo") {}

const keyed = (ownerUserId: string, key: string) =>
  and(eq(sessionStarts.ownerUserId, ownerUserId), eq(sessionStarts.key, key));
// Only a start that has not ended yet ends: made and failed never overwrite each other.
const open = (ownerUserId: string, key: string) =>
  and(keyed(ownerUserId, key), isNull(sessionStarts.sessionId), isNull(sessionStarts.failure));

export const SessionStartsRepoLive: Layer.Layer<SessionStartsRepo, never, MendDB> = Layer.effect(
  SessionStartsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const claim = Effect.fn("SessionStartsRepo.claim")(function* (
      ownerUserId: string,
      key: string,
    ) {
      const rows = yield* db
        .insert(sessionStarts)
        .values({ ownerUserId, key })
        .onConflictDoNothing({ target: [sessionStarts.ownerUserId, sessionStarts.key] })
        .returning({ key: sessionStarts.key })
        .pipe(Effect.orDie);
      return rows.length > 0;
    });

    const made = Effect.fn("SessionStartsRepo.made")(function* (
      ownerUserId: string,
      key: string,
      sessionId: SessionId,
    ) {
      yield* db
        .update(sessionStarts)
        .set({ sessionId })
        .where(open(ownerUserId, key))
        .pipe(Effect.orDie);
    });

    const failed = Effect.fn("SessionStartsRepo.failed")(function* (
      ownerUserId: string,
      key: string,
      failure: string,
    ) {
      yield* db
        .update(sessionStarts)
        .set({ failure })
        .where(open(ownerUserId, key))
        .pipe(Effect.orDie);
    });

    const read = Effect.fn("SessionStartsRepo.read")(function* (ownerUserId: string, key: string) {
      const [row] = yield* db
        .select()
        .from(sessionStarts)
        .where(keyed(ownerUserId, key))
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const forgetBefore = Effect.fn("SessionStartsRepo.forgetBefore")(function* (before: Date) {
      const rows = yield* db
        .delete(sessionStarts)
        .where(lt(sessionStarts.createdAt, before))
        .returning({ key: sessionStarts.key })
        .pipe(Effect.orDie);
      return rows.length;
    });

    return { claim, made, failed, read, forgetBefore };
  }),
);
