import { PgClient } from "@effect/sql-pg";
import type { ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { fenceStep, REMOVAL_FENCE_LEASE_SECONDS, type RemovalPhase } from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { isDriverError } from "./unique-violation.ts";

/** One removal attempt's mark: only its holder advances or clears it. */
export const RemovalFenceId = Schema.String.pipe(Schema.brand("RemovalFenceId"));
export type RemovalFenceId = typeof RemovalFenceId.Type;

export type FencedRow =
  | { readonly kind: "worktree"; readonly id: WorktreeId }
  | { readonly kind: "project"; readonly id: ProjectId };

export type FenceTaken =
  /** The mark is this removal's: read what stands in the way, then commit or release. */
  | { readonly _tag: "held"; readonly id: RemovalFenceId }
  /**
   * An earlier removal passed its checks and stopped while deleting: only the deletion is left.
   * The mark is this removal's now, under a new id, so no other removal finishes it at once.
   */
  | { readonly _tag: "finish"; readonly id: RemovalFenceId }
  /** Another removal holds this row's mark, its project's, or (for a project) a worktree's. */
  | { readonly _tag: "underway" }
  /** No such row: removed already. */
  | { readonly _tag: "gone" };

/** The SQLSTATE migration 0164's triggers raise for a start a removal's mark refuses. */
export const REMOVAL_FENCED_SQLSTATE = "MRFEN";

/**
 * New work refused before it reached the database, as its triggers would have refused it: the
 * same defect, so every caller and the API's error boundary answer the two alike.
 */
export class RemovalFenced extends Error {
  readonly code = REMOVAL_FENCED_SQLSTATE;
}

/** Whether a failed query was a session start or a new worktree refused by a removal's mark. */
export const isRemovalFenced = (error: unknown): boolean =>
  isDriverError(error, REMOVAL_FENCED_SQLSTATE);

/**
 * A removal's mark on the worktree or project row it removes (docs/adr/0007-landing.md,
 * "Worktree removal"). While a removal reads what stands in the way, the mark makes migration
 * 0164's triggers refuse any session that would become live there, so nothing starts between its
 * checks and its deletion; a start that committed first is what the checks then read. Each step is
 * one short transaction: no lock is held across git, the network or the disk.
 */
export class RemovalFencesRepo extends Context.Service<
  RemovalFencesRepo,
  {
    readonly take: (row: FencedRow) => Effect.Effect<FenceTaken>;
    /**
     * Keeps a `checking` mark fresh while its checks run; false once the mark is no longer `id`'s
     * or lapsed, after which the checks may have missed a start and nothing may be deleted.
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
     * A deletion under mark `id` failed partway: the row stays marked `deleting`, and the next
     * removal finishes it at once instead of waiting out the lease.
     */
    readonly handOver: (row: FencedRow, id: RemovalFenceId) => Effect.Effect<void>;
    /** Whether a session may start in the worktree now, as the triggers judge it. */
    readonly admitsStart: (place: {
      readonly projectId: ProjectId;
      readonly worktreeId: WorktreeId | null;
    }) => Effect.Effect<boolean>;
    /**
     * Whether new work (a shell, a Service, a screen) may start for the session now: no removal
     * marks its project, its worktree, or a worktree it holds as a repository.
     */
    readonly admitsSessionWork: (sessionId: SessionId) => Effect.Effect<boolean>;
  }
>()("@mend/db/RemovalFencesRepo") {}

const FenceRow = Schema.Struct({
  phase: Schema.NullOr(Schema.Literals(["checking", "deleting"])),
  id: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.Date),
  now: Schema.Date,
});
const decodeFenceRow = Schema.decodeUnknownSync(FenceRow);

const tableOf = (row: FencedRow) => (row.kind === "worktree" ? "worktrees" : "projects");

export const RemovalFencesRepoLive: Layer.Layer<RemovalFencesRepo, never, PgClient.PgClient> =
  Layer.effect(
    RemovalFencesRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;

      /**
       * Whether a removal of the project, or of one of its worktrees, is at work now. A stale mark
       * is a removal that stopped: this one removes what it would have, or more.
       */
      const relativeAtWork = (row: FencedRow) =>
        row.kind === "worktree"
          ? sql<{ readonly marked: boolean }>`
              SELECT p.removal_since > now() - make_interval(secs => ${REMOVAL_FENCE_LEASE_SECONDS})
                AS marked
              FROM projects p JOIN worktrees w ON w.project_id = p.id
              WHERE w.id = ${row.id}`
          : sql<{ readonly marked: boolean }>`
              SELECT EXISTS (
                SELECT 1 FROM worktrees
                WHERE project_id = ${row.id}
                  AND removal_since > now() - make_interval(secs => ${REMOVAL_FENCE_LEASE_SECONDS})
              ) AS marked`;

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
                SELECT removal_phase AS phase, removal_id AS id, removal_since AS since,
                       now() AS now
                FROM ${sql(tableOf(row))} WHERE id = ${row.id} FOR NO KEY UPDATE`;
              if (found === undefined) return { _tag: "gone" } as const;
              const fence = decodeFenceRow(found);
              const step = fenceStep(
                fence.phase === null || fence.since === null
                  ? null
                  : { phase: fence.phase, since: fence.since },
                fence.now,
              );
              if (step._tag === "underway") return { _tag: "underway" } as const;
              const [relative] = yield* relativeAtWork(row);
              if (relative?.marked === true) return { _tag: "underway" } as const;
              const id = RemovalFenceId.make(`rmv_${crypto.randomUUID()}`);
              const phase: RemovalPhase = step._tag === "finish" ? "deleting" : "checking";
              yield* sql`
                UPDATE ${sql(tableOf(row))}
                SET removal_phase = ${phase}, removal_id = ${id}, removal_since = now()
                WHERE id = ${row.id}`;
              return step._tag === "finish"
                ? ({ _tag: "finish", id } as const)
                : ({ _tag: "held", id } as const);
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
          WHERE id = ${row.id} AND removal_id = ${id} AND removal_phase = 'checking'
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
          WHERE id = ${row.id} AND removal_id = ${id}
            AND removal_fence_marked(removal_phase, removal_since)
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
          SET removal_since = now() - make_interval(secs => ${REMOVAL_FENCE_LEASE_SECONDS + 1})
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

      const admitsSessionWork = Effect.fn("RemovalFencesRepo.admitsSessionWork")(function* (
        sessionId: SessionId,
      ) {
        const marked = yield* sql<{ readonly marked: boolean }>`
          SELECT removal_fence_session_marked(${sessionId}) AS marked`.pipe(Effect.orDie);
        return marked[0]?.marked !== true;
      });

      return { take, renew, commit, release, handOver, admitsStart, admitsSessionWork };
    }),
  );
