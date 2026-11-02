import type { SessionId } from "@mend/domain";
import { and, eq, gt, isNotNull, or } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionInboxMarks } from "../schema/workbench.ts";

/** One person's mark on one session: snoozed until a time, or settled. Exactly one is set. */
export interface SessionInboxMarkRow {
  readonly sessionId: SessionId;
  readonly snoozedUntil: Date | null;
  readonly settledAt: Date | null;
}

export type SessionInboxMarkChange =
  | { readonly _tag: "Snoozed"; readonly until: Date }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Inbox" };

/** Where each person keeps a session in their inbox. Per account: nobody else's inbox moves. */
export class SessionInboxMarksRepo extends Context.Service<
  SessionInboxMarksRepo,
  {
    /** The account's marks still in force at `now`: settled ones, and snoozes not over yet. */
    readonly forUser: (
      userId: string,
      now: Date,
    ) => Effect.Effect<ReadonlyArray<SessionInboxMarkRow>>;
    /** Snooze, settle, or clear the mark (`Inbox`); answers the mark, or null once cleared. */
    readonly set: (
      userId: string,
      sessionId: SessionId,
      change: SessionInboxMarkChange,
    ) => Effect.Effect<SessionInboxMarkRow | null>;
  }
>()("@mend/db/SessionInboxMarksRepo") {}

const selected = {
  sessionId: sessionInboxMarks.sessionId,
  snoozedUntil: sessionInboxMarks.snoozedUntil,
  settledAt: sessionInboxMarks.settledAt,
};

export const SessionInboxMarksRepoLive: Layer.Layer<SessionInboxMarksRepo, never, MendDB> =
  Layer.effect(
    SessionInboxMarksRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const forUser = Effect.fn("SessionInboxMarksRepo.forUser")(function* (
        userId: string,
        now: Date,
      ) {
        return yield* db
          .select(selected)
          .from(sessionInboxMarks)
          .where(
            and(
              eq(sessionInboxMarks.userId, userId),
              or(isNotNull(sessionInboxMarks.settledAt), gt(sessionInboxMarks.snoozedUntil, now)),
            ),
          )
          .pipe(Effect.orDie);
      });

      const set = Effect.fn("SessionInboxMarksRepo.set")(function* (
        userId: string,
        sessionId: SessionId,
        change: SessionInboxMarkChange,
      ) {
        const where = and(
          eq(sessionInboxMarks.userId, userId),
          eq(sessionInboxMarks.sessionId, sessionId),
        );
        if (change._tag === "Inbox") {
          yield* db.delete(sessionInboxMarks).where(where).pipe(Effect.orDie);
          return null;
        }
        const now = yield* DateTime.nowAsDate;
        const values =
          change._tag === "Snoozed"
            ? { snoozedUntil: change.until, settledAt: null }
            : { snoozedUntil: null, settledAt: now };
        const [row] = yield* db
          .insert(sessionInboxMarks)
          .values({ userId, sessionId, ...values, updatedAt: now })
          .onConflictDoUpdate({
            target: [sessionInboxMarks.userId, sessionInboxMarks.sessionId],
            set: { ...values, updatedAt: now },
          })
          .returning(selected)
          .pipe(Effect.orDie);
        if (row === undefined)
          return yield* Effect.die("session inbox mark upsert returned no row");
        return row;
      });

      return { forUser, set };
    }),
  );
