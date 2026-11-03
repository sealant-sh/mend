import type { SessionId } from "@mend/domain";
import { and, eq, gt, ne, or } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionInboxMarks } from "../schema/workbench.ts";

/**
 * One person's mark on one session: snoozed until a time, settled, or kept in the inbox though
 * its status would settle it. `snoozedUntil` is set exactly when the state is `snoozed`.
 */
export interface SessionInboxMarkRow {
  readonly sessionId: SessionId;
  readonly state: "inbox" | "snoozed" | "settled";
  readonly snoozedUntil: Date | null;
  readonly markedAt: Date;
}

export type SessionInboxMarkChange =
  | { readonly _tag: "Snoozed"; readonly until: Date }
  | { readonly _tag: "Settled" }
  | { readonly _tag: "Inbox" };

/** Where each person keeps a session in their inbox. Per account: nobody else's inbox moves. */
export class SessionInboxMarksRepo extends Context.Service<
  SessionInboxMarksRepo,
  {
    /** The account's marks still in force at `now`: settled and kept ones, snoozes not over. */
    readonly forUser: (
      userId: string,
      now: Date,
    ) => Effect.Effect<ReadonlyArray<SessionInboxMarkRow>>;
    /** Snooze, settle, or keep the session in the inbox; answers the mark as saved. */
    readonly set: (
      userId: string,
      sessionId: SessionId,
      change: SessionInboxMarkChange,
    ) => Effect.Effect<SessionInboxMarkRow>;
  }
>()("@mend/db/SessionInboxMarksRepo") {}

const selected = {
  sessionId: sessionInboxMarks.sessionId,
  state: sessionInboxMarks.state,
  snoozedUntil: sessionInboxMarks.snoozedUntil,
  markedAt: sessionInboxMarks.markedAt,
};

const STATE = { Snoozed: "snoozed", Settled: "settled", Inbox: "inbox" } as const;

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
              or(ne(sessionInboxMarks.state, "snoozed"), gt(sessionInboxMarks.snoozedUntil, now)),
            ),
          )
          .pipe(Effect.orDie);
      });

      const set = Effect.fn("SessionInboxMarksRepo.set")(function* (
        userId: string,
        sessionId: SessionId,
        change: SessionInboxMarkChange,
      ) {
        const values = {
          state: STATE[change._tag],
          snoozedUntil: change._tag === "Snoozed" ? change.until : null,
          markedAt: yield* DateTime.nowAsDate,
        };
        const [row] = yield* db
          .insert(sessionInboxMarks)
          .values({ userId, sessionId, ...values })
          .onConflictDoUpdate({
            target: [sessionInboxMarks.userId, sessionInboxMarks.sessionId],
            set: values,
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
