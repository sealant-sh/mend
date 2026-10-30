import { PgClient } from "@effect/sql-pg";
import { type ProjectId, SessionId, type WorktreeId } from "@mend/domain";
import type { StoppedRemoval } from "@mend/domain/workbench";
import { Effect, Fiber, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { isDriverError } from "./unique-violation.ts";

/** One removal attempt's mark: only its holder advances or clears it. */
export const RemovalFenceId = Schema.String.pipe(Schema.brand("RemovalFenceId"));
export type RemovalFenceId = typeof RemovalFenceId.Type;

/** One admitted start (`session_admissions`). */
export const SessionAdmissionId = Schema.String.pipe(Schema.brand("SessionAdmissionId"));
export type SessionAdmissionId = typeof SessionAdmissionId.Type;

export type FencedRow =
  | { readonly kind: "worktree"; readonly id: WorktreeId }
  | { readonly kind: "project"; readonly id: ProjectId };

export type FenceTaken =
  /** The mark is this removal's: read what stands in the way, then commit or release. */
  | { readonly _tag: "held"; readonly id: RemovalFenceId }
  /**
   * An earlier removal passed its checks and stopped while deleting: only the deletion is left.
   * The mark is this removal's now, under a new id, so the one that stopped can no longer act.
   */
  | { readonly _tag: "finish"; readonly id: RemovalFenceId }
  /**
   * Another removal holds this row's mark, its project's, or (for a project) a worktree's.
   * `stopped`: that one is a deletion of the project or a worktree that stopped partway, which
   * only removing it again finishes.
   */
  | { readonly _tag: "underway"; readonly stopped: StoppedRemoval | null }
  /** No such row: removed already. */
  | { readonly _tag: "gone" };

/** How often a holder renews its mark or an admission: a quarter of migration 0164's 120 s. */
export const REMOVAL_FENCE_RENEW_EVERY = "30 seconds";

/**
 * The SQLSTATEs migration 0164's triggers raise for new work a removal's mark refuses: MRFEN while
 * a removal is at work, MRFES for a deletion that stopped partway.
 */
export const REMOVAL_FENCED_SQLSTATE = "MRFEN";
export const REMOVAL_STOPPED_SQLSTATE = "MRFES";

/**
 * New work refused before it reached the database, as its triggers would have refused it: the
 * same defect, so every caller and the API's error boundary answer the two alike.
 */
export class RemovalFenced extends Error {
  readonly code = REMOVAL_FENCED_SQLSTATE;
}

/** Whether a failed query was new work refused by a removal's mark. */
export const isRemovalFenced = (error: unknown): boolean =>
  isDriverError(error, REMOVAL_FENCED_SQLSTATE) || isDriverError(error, REMOVAL_STOPPED_SQLSTATE);

/** Whether the mark that refused it is a deletion that stopped partway. */
export const isRemovalStopped = (error: unknown): boolean =>
  isDriverError(error, REMOVAL_STOPPED_SQLSTATE);

/**
 * A removal's mark on the worktree or project row it removes (docs/adr/0007-landing.md,
 * "Worktree removal"). While a removal reads what stands in the way and while it deletes, the
 * mark makes migration 0164's triggers refuse new work there, so nothing starts between its
 * checks and its deletion; a start that committed first is what the checks then read. Whether a
 * mark stands is decided only in SQL (`removal_fence_marked`, `removal_fence_fresh`). Each step is
 * one short transaction: no lock is held across git, the network or the disk.
 */
export class RemovalFencesRepo extends Context.Service<
  RemovalFencesRepo,
  {
    readonly take: (row: FencedRow) => Effect.Effect<FenceTaken>;
    /**
     * Keeps the mark fresh while its holder checks or deletes; false once the mark is no longer
     * `id`'s, or a check's mark lapsed, after which nothing may be deleted under `id`.
     */
    readonly renew: (row: FencedRow, id: RemovalFenceId) => Effect.Effect<boolean>;
    /**
     * `checking` → `deleting`, only while the mark is still `id` and fresh. False: the mark lapsed,
     * or another removal took it over; nothing may be deleted.
     */
    readonly commit: (row: FencedRow, id: RemovalFenceId) => Effect.Effect<boolean>;
    /** Clears the mark, only while it is still `id`. */
    readonly release: (row: FencedRow, id: RemovalFenceId) => Effect.Effect<void>;
    /**
     * A deletion under mark `id` failed partway and has stopped: the row stays marked `deleting`,
     * and the next removal finishes it at once instead of waiting out the lease.
     */
    readonly handOver: (row: FencedRow, id: RemovalFenceId) => Effect.Effect<void>;
    /** Whether a session may start in the worktree (or a new one in the project) now. */
    readonly admitsStart: (place: {
      readonly projectId: ProjectId;
      readonly worktreeId: WorktreeId | null;
    }) => Effect.Effect<boolean>;
    /**
     * Admits a start of the session before it runs anything: refused (a defect `isRemovalFenced`
     * recognizes) while a removal marks a place it works in, unless the session is live already.
     */
    readonly admit: (sessionId: SessionId) => Effect.Effect<SessionAdmissionId>;
    readonly renewAdmission: (id: SessionAdmissionId) => Effect.Effect<void>;
    readonly endAdmission: (id: SessionAdmissionId) => Effect.Effect<void>;
    /**
     * Every session working in the worktree (`removal_fence_sessions_in`): its own, those holding
     * it as a repository, and those of projects linking it.
     */
    readonly sessionsIn: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<SessionId>>;
    /** Of those, the ones with a start admitted and still under way. */
    readonly startingIn: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<SessionId>>;
  }
>()("@mend/db/RemovalFencesRepo") {}

/**
 * Runs `start` admitted (`RemovalFencesRepo.admit`), renewing the admission while it runs and
 * ending it however `start` ends: by then what the start made is on its rows.
 */
export const whileAdmitted = <A, E, R>(
  fences: RemovalFencesRepo["Service"],
  sessionId: SessionId,
  start: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    fences.admit(sessionId),
    (id) =>
      Effect.gen(function* () {
        const renewal = yield* Effect.forkChild(
          Effect.interruptible(
            Effect.forever(
              Effect.sleep(REMOVAL_FENCE_RENEW_EVERY).pipe(
                Effect.andThen(fences.renewAdmission(id)),
              ),
            ),
          ),
        );
        return yield* start.pipe(Effect.ensuring(Fiber.interrupt(renewal)));
      }),
    (id) => fences.endAdmission(id),
  );

const FenceRow = Schema.Struct({
  marked: Schema.Boolean,
  fresh: Schema.Boolean,
});
const decodeFenceRow = Schema.decodeUnknownSync(FenceRow);

const Relative = Schema.Struct({
  kind: Schema.Literals(["worktree", "project"]),
  name: Schema.String,
  fresh: Schema.Boolean,
});
const decodeRelatives = Schema.decodeUnknownSync(Schema.Array(Relative));

const SessionIdRow = Schema.Struct({ id: SessionId });
const decodeSessionIds = Schema.decodeUnknownSync(Schema.Array(SessionIdRow));

const tableOf = (row: FencedRow) => (row.kind === "worktree" ? "worktrees" : "projects");

export const RemovalFencesRepoLive: Layer.Layer<RemovalFencesRepo, never, PgClient.PgClient> =
  Layer.effect(
    RemovalFencesRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      /** A removal of the project, or of one of its worktrees, whose mark stands. */
      const relativesMarked = (row: FencedRow) =>
        row.kind === "worktree"
          ? sql`
              SELECT 'project' AS kind, p.name, removal_fence_fresh(p.removal_since) AS fresh
              FROM projects p JOIN worktrees w ON w.project_id = p.id
              WHERE w.id = ${row.id} AND removal_fence_marked(p.removal_phase, p.removal_since)`
          : sql`
              SELECT 'worktree' AS kind, name, removal_fence_fresh(removal_since) AS fresh
              FROM worktrees
              WHERE project_id = ${row.id} AND removal_fence_marked(removal_phase, removal_since)
              ORDER BY removal_fence_fresh(removal_since) DESC, name`;

      const take = Effect.fn("RemovalFencesRepo.take")(function* (row: FencedRow) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Projects before worktrees, as the triggers lock them: a worktree's removal and
              // its project's take turns here, and each sees the other's mark.
              if (row.kind === "worktree") {
                yield* sql`
                  SELECT 1 FROM projects
                  WHERE id = (SELECT project_id FROM worktrees WHERE id = ${row.id})
                  FOR SHARE`;
              }
              const [found] = yield* sql`
                SELECT removal_fence_marked(removal_phase, removal_since) AS marked,
                       removal_fence_fresh(removal_since) AS fresh
                FROM ${sql(tableOf(row))} WHERE id = ${row.id} FOR NO KEY UPDATE`;
              if (found === undefined) return { _tag: "gone" } as const;
              const fence = decodeFenceRow(found);
              if (fence.fresh) return { _tag: "underway", stopped: null } as const;
              const [relative] = decodeRelatives(yield* relativesMarked(row));
              if (relative !== undefined) {
                return {
                  _tag: "underway",
                  stopped: relative.fresh ? null : { kind: relative.kind, name: relative.name },
                } as const;
              }
              // Marked but not fresh: a `deleting` mark whose holder stopped renewing it.
              const finish = fence.marked;
              const id = RemovalFenceId.make(`rmv_${crypto.randomUUID()}`);
              yield* sql`
                UPDATE ${sql(tableOf(row))}
                SET removal_phase = ${finish ? "deleting" : "checking"}, removal_id = ${id},
                    removal_since = now()
                WHERE id = ${row.id}`;
              return finish ? ({ _tag: "finish", id } as const) : ({ _tag: "held", id } as const);
            }),
          )
          .pipe(Effect.orDie);
      });

      const renew = Effect.fn("RemovalFencesRepo.renew")(function* (
        row: FencedRow,
        id: RemovalFenceId,
      ) {
        const updated = yield* sql`
          UPDATE ${sql(tableOf(row))}
          SET removal_since = now()
          WHERE id = ${row.id} AND removal_id = ${id}
            AND removal_fence_marked(removal_phase, removal_since)
          RETURNING id`.pipe(Effect.orDie);
        return updated.length > 0;
      });

      const commit = Effect.fn("RemovalFencesRepo.commit")(function* (
        row: FencedRow,
        id: RemovalFenceId,
      ) {
        const updated = yield* sql`
          UPDATE ${sql(tableOf(row))}
          SET removal_phase = 'deleting', removal_since = now()
          WHERE id = ${row.id} AND removal_id = ${id} AND removal_phase = 'checking'
            AND removal_fence_fresh(removal_since)
          RETURNING id`.pipe(Effect.orDie);
        return updated.length > 0;
      });

      const release = Effect.fn("RemovalFencesRepo.release")(function* (
        row: FencedRow,
        id: RemovalFenceId,
      ) {
        yield* sql`
          UPDATE ${sql(tableOf(row))}
          SET removal_phase = NULL, removal_id = NULL, removal_since = NULL
          WHERE id = ${row.id} AND removal_id = ${id}`.pipe(Effect.orDie);
      });

      const handOver = Effect.fn("RemovalFencesRepo.handOver")(function* (
        row: FencedRow,
        id: RemovalFenceId,
      ) {
        yield* sql`
          UPDATE ${sql(tableOf(row))}
          SET removal_since = '-infinity'
          WHERE id = ${row.id} AND removal_id = ${id} AND removal_phase = 'deleting'`.pipe(
          Effect.orDie,
        );
      });

      const admitsStart = Effect.fn("RemovalFencesRepo.admitsStart")(function* (place: {
        readonly projectId: ProjectId;
        readonly worktreeId: WorktreeId | null;
      }) {
        const marked = yield* sql<{ readonly marked: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM projects
            WHERE id = ${place.projectId} AND removal_fence_marked(removal_phase, removal_since)
          ) OR EXISTS (
            SELECT 1 FROM worktrees
            WHERE id = ${place.worktreeId} AND removal_fence_marked(removal_phase, removal_since)
          ) AS marked`.pipe(Effect.orDie);
        return marked[0]?.marked !== true;
      });

      const admit = Effect.fn("RemovalFencesRepo.admit")(function* (sessionId: SessionId) {
        const id = SessionAdmissionId.make(`adm_${crypto.randomUUID()}`);
        yield* sql`
          INSERT INTO session_admissions (id, session_id) VALUES (${id}, ${sessionId})`.pipe(
          Effect.orDie,
        );
        return id;
      });

      const renewAdmission = Effect.fn("RemovalFencesRepo.renewAdmission")(function* (
        id: SessionAdmissionId,
      ) {
        yield* sql`UPDATE session_admissions SET since = now() WHERE id = ${id}`.pipe(Effect.orDie);
      });

      const endAdmission = Effect.fn("RemovalFencesRepo.endAdmission")(function* (
        id: SessionAdmissionId,
      ) {
        yield* sql`DELETE FROM session_admissions WHERE id = ${id}`.pipe(Effect.orDie);
      });

      const sessionsIn = Effect.fn("RemovalFencesRepo.sessionsIn")(function* (
        worktreeId: WorktreeId,
      ) {
        return decodeSessionIds(
          yield* sql`
            SELECT session_id AS id FROM removal_fence_sessions_in(${worktreeId})
            ORDER BY session_id`.pipe(Effect.orDie),
        ).map((row) => row.id);
      });

      const startingIn = Effect.fn("RemovalFencesRepo.startingIn")(function* (
        worktreeId: WorktreeId,
      ) {
        return decodeSessionIds(
          yield* sql`
            SELECT DISTINCT a.session_id AS id
            FROM session_admissions a
            JOIN removal_fence_sessions_in(${worktreeId}) s ON s.session_id = a.session_id
            WHERE removal_fence_fresh(a.since)
            ORDER BY a.session_id`.pipe(Effect.orDie),
        ).map((row) => row.id);
      });

      return {
        take,
        renew,
        commit,
        release,
        handOver,
        admitsStart,
        admit,
        renewAdmission,
        endAdmission,
        sessionsIn,
        startingIn,
      };
    }),
  );
