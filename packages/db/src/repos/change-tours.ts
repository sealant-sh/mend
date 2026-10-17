import { PgClient } from "@effect/sql-pg";
import type { ChangeId, SessionId } from "@mend/domain";
import { ChangeTour, TourStop } from "@mend/domain/workbench";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { changeTours, worktreeChanges } from "../schema/workbench.ts";

const decodeTour = Schema.decodeUnknownEffect(Schema.Struct(ChangeTour.fields));
const encodeStops = Schema.encodeEffect(Schema.Array(TourStop));

export interface NewChangeTour {
  readonly changeId: ChangeId;
  readonly sessionId: SessionId;
  readonly summary: string;
  readonly approach: string | null;
  readonly stops: ReadonlyArray<TourStop>;
  readonly diffDigest: string;
}

/** The composed review tour — one per change, replaced whole on recompose. */
export class ChangeToursRepo extends Context.Service<
  ChangeToursRepo,
  {
    readonly upsert: (tour: NewChangeTour) => Effect.Effect<ChangeTour>;
    readonly byChange: (changeId: ChangeId) => Effect.Effect<ChangeTour | null>;
  }
>()("@mend/db/ChangeToursRepo") {}

const decodeRow = (row: typeof changeTours.$inferSelect) =>
  decodeTour(row).pipe(
    Effect.map((decoded) => new ChangeTour(decoded)),
    Effect.orDie,
  );

export const ChangeToursRepoLive: Layer.Layer<ChangeToursRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    ChangeToursRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const sql = yield* PgClient.PgClient;

      const notify = Effect.fn("ChangeToursRepo.notify")(function* (
        changeId: ChangeId,
        sessionId: SessionId,
      ) {
        const [row] = yield* db
          .select({ projectId: worktreeChanges.projectId, worktreeId: worktreeChanges.worktreeId })
          .from(worktreeChanges)
          .where(eq(worktreeChanges.id, changeId))
          .limit(1)
          .pipe(Effect.orDie);
        yield* notifyEvent(sql, {
          type: "session-change",
          changeId,
          worktreeId: row?.worktreeId ?? "",
          sessionId,
          projectId: row?.projectId ?? "",
        });
      });

      const upsert = Effect.fn("ChangeToursRepo.upsert")(function* (tour: NewChangeTour) {
        const stops = yield* encodeStops(tour.stops).pipe(Effect.orDie);
        const [row] = yield* db
          .insert(changeTours)
          .values({ id: crypto.randomUUID(), ...tour, stops })
          .onConflictDoUpdate({
            target: changeTours.changeId,
            set: {
              summary: tour.summary,
              approach: tour.approach,
              stops,
              diffDigest: tour.diffDigest,
              createdAt: yield* DateTime.nowAsDate,
            },
          })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("change tour upsert returned no row");
        const created = yield* decodeRow(row);
        yield* notify(tour.changeId, tour.sessionId);
        return created;
      });

      const byChange = Effect.fn("ChangeToursRepo.byChange")(function* (changeId: ChangeId) {
        const [row] = yield* db
          .select()
          .from(changeTours)
          .where(eq(changeTours.changeId, changeId))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : yield* decodeRow(row);
      });

      return { upsert, byChange };
    }),
  );
