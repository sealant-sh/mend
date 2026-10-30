import { PgClient } from "@effect/sql-pg";
import { type ProjectId, SessionId, type WorktreeId } from "@mend/domain";
import type { StoppedRemoval } from "@mend/domain/workbench";
import { Effect, Fiber, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { notifyEvent } from "../events.ts";
import { ProjectNameTakenError } from "./projects.ts";
import { isDriverError } from "./unique-violation.ts";
import { uniqueViolationConstraint } from "./unique-violation.ts";
import { upgradeTicketScope } from "./upgrade-tickets.ts";

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

/** How often a holder renews its mark or an admission: a quarter of migration 0166's 120 s. */
export const REMOVAL_FENCE_RENEW_EVERY = "30 seconds";

/**
 * The SQLSTATEs migration 0166's triggers raise for new work a removal's mark refuses: MRFEN while
 * a removal is at work, MRFES for a deletion that stopped partway.
 */
export const REMOVAL_FENCED_SQLSTATE = "MRFEN";
export const REMOVAL_STOPPED_SQLSTATE = "MRFES";
export const REMOVED_PROJECT_SQLSTATE = "MRFRM";

/**
 * New work refused before it reached the database, as its triggers would have refused it: the
 * same defect, so every caller and the API's error boundary answer the two alike.
 */
export class RemovalFenced extends Error {
  readonly code = REMOVAL_FENCED_SQLSTATE;
}

/** Whether a failed query was new work refused by a removal's mark. */
export const isRemovalFenced = (error: unknown): boolean =>
  isDriverError(error, REMOVAL_FENCED_SQLSTATE) ||
  isDriverError(error, REMOVAL_STOPPED_SQLSTATE) ||
  isRemovedProject(error);

export const isRemovedProject = (error: unknown): boolean =>
  isDriverError(error, REMOVED_PROJECT_SQLSTATE);

/** Whether the mark that refused it is a deletion that stopped partway. */
export const isRemovalStopped = (error: unknown): boolean =>
  isDriverError(error, REMOVAL_STOPPED_SQLSTATE);

/**
 * A removal's mark on the worktree or project row it removes (docs/adr/0007-landing.md,
 * "Worktree removal"). While a removal reads what stands in the way and while it deletes, the
 * mark makes migration 0166's triggers refuse new work there, so nothing starts between its
 * checks and its deletion; a start that committed first is what the checks then read. Whether a
 * mark stands is decided only in SQL (`removal_fence_marked`, `removal_fence_fresh`). Each step is
 * one short transaction: no lock is held across git, the network or the disk.
 */
export class RemovalFencesRepo extends Context.Service<
  RemovalFencesRepo,
  {
    /**
     * `checking` → `removed` under mark `mark`, with its audit entry, revoking what opens the
     * project. `forbidden`: `userId` may no longer remove it (`canRemoveProject`), read under the
     * lock of their membership. `lost`: the mark lapsed or went to another removal.
     */
    readonly keep: (
      id: ProjectId,
      mark: RemovalFenceId,
      userId: string,
    ) => Effect.Effect<"kept" | "lost" | "forbidden">;
    readonly restore: (
      id: ProjectId,
      userId: string,
      name?: string,
    ) => Effect.Effect<
      "restored" | "listed" | "purging" | "legacy" | "gone" | "forbidden",
      ProjectNameTakenError
    >;
    readonly takePurge: (
      id: ProjectId,
      userId: string,
    ) => Effect.Effect<FenceTaken | { readonly _tag: "forbidden" }>;
    /**
     * Deletes the purged project's row, its exclusive context snapshots and its audit entry in one
     * transaction, only while `mark` is still the purge's and fresh. False: it is not.
     */
    readonly finishPurge: (
      id: ProjectId,
      mark: RemovalFenceId,
      userId: string,
    ) => Effect.Effect<boolean>;
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

      /** `canRemoveProject` for `by` on project `p`, as their membership reads now. */
      const mayRemove = (by: string) => sql`EXISTS (SELECT 1 FROM organization_members m
        WHERE m.user_id = ${by} AND m.organization_id = p.organization_id
          AND ((p.visibility = 'private' AND p.created_by_user_id = ${by})
               OR (p.visibility = 'shared' AND m.role = 'owner')))`;
      /** Holds `by`'s membership, so a demotion or a removal waits for this lifecycle change. */
      const lockMembership = (id: ProjectId, by: string) =>
        sql`SELECT 1 FROM organization_members WHERE user_id = ${by}
          AND organization_id = (SELECT organization_id FROM projects WHERE id = ${id}) FOR SHARE`;
      const audited = (id: ProjectId, by: string, action: string) =>
        sql`INSERT INTO audit_events (id, organization_id, actor_user_id, action, subject_type, subject_id, data)
          SELECT ${crypto.randomUUID()}, organization_id, ${by}, ${action}, 'project', id, '{}'::jsonb
          FROM projects WHERE id = ${id}`;

      const keep = Effect.fn("RemovalFencesRepo.keep")(function* (
        id: ProjectId,
        mark: RemovalFenceId,
        userId: string,
      ) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* lockMembership(id, userId);
              const [row] = yield* sql<{ readonly held: boolean; readonly allowed: boolean }>`
                SELECT (removal_id = ${mark} AND removal_phase = 'checking'
                        AND removal_fence_fresh(removal_since)) AS held,
                       ${mayRemove(userId)} AS allowed
                FROM projects p WHERE id = ${id} FOR NO KEY UPDATE`;
              if (row?.held !== true) return "lost" as const;
              if (!row.allowed) return "forbidden" as const;
              yield* sql`UPDATE projects SET removal_phase = 'removed', removed_at = now(),
                removed_by_user_id = ${userId}, updated_at = now() WHERE id = ${id}`;
              yield* sql`DELETE FROM preview_grants WHERE preview_id IN (SELECT id FROM previews WHERE project_id = ${id})`;
              // Every ticket that opens something of the project: a renewal would otherwise mint
              // terminal tickets again once the project is restored. Scopes are built by
              // `upgradeTicketScope`, so the pairs are too.
              const opened = yield* sql<{ readonly key: string; readonly value: string }>`
                SELECT 'session' AS key, id AS value FROM agent_sessions WHERE project_id = ${id}
                UNION ALL SELECT 'process', p.id FROM session_processes p
                  JOIN agent_sessions a ON a.id = p.session_id WHERE a.project_id = ${id}
                UNION ALL SELECT 'service', v.id FROM services v
                  JOIN agent_sessions a ON a.id = v.session_id WHERE a.project_id = ${id}
                UNION ALL SELECT 'preview', id FROM previews WHERE project_id = ${id}`;
              const pairs = opened.map(({ key, value }) => upgradeTicketScope({ [key]: value }));
              if (pairs.length > 0)
                yield* sql`DELETE FROM upgrade_tickets t WHERE EXISTS (
                  SELECT 1 FROM regexp_split_to_table(t.scope, '&') pair WHERE pair IN ${sql.in(pairs)})`;
              yield* sql`INSERT INTO preview_controls (preview_id, revision, state)
                SELECT id, 1, 'automatic' FROM previews WHERE project_id = ${id}
                ON CONFLICT (preview_id) DO UPDATE SET revision = preview_controls.revision + 1, updated_at = now()`;
              yield* audited(id, userId, "project.removed");
              yield* notifyEvent(sql, { type: "project", projectId: id });
              return "kept" as const;
            }),
          )
          .pipe(Effect.orDie);
      });

      const restore = Effect.fn("RemovalFencesRepo.restore")(function* (
        id: ProjectId,
        userId: string,
        name?: string,
      ) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // Serialize scratch recovery with other restores by the same creator.
              yield* sql`SELECT 1 FROM "user" WHERE id = ${userId} FOR UPDATE`;
              yield* lockMembership(id, userId);
              const [row] = yield* sql<{
                readonly phase: string | null;
                readonly legacy: boolean;
                readonly allowed: boolean;
              }>`
                SELECT removal_phase AS phase, removal_legacy AS legacy, ${mayRemove(userId)} AS allowed
                FROM projects p WHERE id = ${id} FOR NO KEY UPDATE`;
              if (row === undefined) return "gone" as const;
              if (!row.allowed) return "forbidden" as const;
              if (row.legacy) return "legacy" as const;
              if (row.phase === "deleting") return "purging" as const;
              if (row.phase !== "removed") return "listed" as const;
              yield* sql`UPDATE projects p SET name = coalesce(${name ?? null}, name),
                scratch_owner_user_id = CASE WHEN EXISTS (SELECT 1 FROM projects other
                  WHERE other.id <> p.id AND other.removed_at IS NULL
                    AND other.scratch_owner_user_id = p.scratch_owner_user_id) THEN NULL ELSE p.scratch_owner_user_id END,
                removal_phase = NULL, removal_id = NULL, removal_since = NULL,
                removed_at = NULL, removed_by_user_id = NULL, updated_at = now()
                WHERE id = ${id}`;
              yield* audited(id, userId, "project.restored");
              yield* notifyEvent(sql, { type: "project", projectId: id });
              return "restored" as const;
            }),
          )
          .pipe(
            Effect.catch((error) =>
              uniqueViolationConstraint(error) === "projects_organization_name_key"
                ? Effect.fail(new ProjectNameTakenError({ name: name ?? "" }))
                : Effect.die(error),
            ),
          );
      });

      const takePurge = Effect.fn("RemovalFencesRepo.takePurge")(function* (
        projectId: ProjectId,
        userId: string,
      ) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* lockMembership(projectId, userId);
              const [row] = yield* sql<{
                readonly phase: string | null;
                readonly fresh: boolean;
                readonly removed: boolean;
                readonly allowed: boolean;
              }>`
                SELECT removal_phase AS phase, removal_fence_fresh(removal_since) AS fresh,
                       removed_at IS NOT NULL AS removed, ${mayRemove(userId)} AS allowed
                FROM projects p WHERE id = ${projectId} FOR NO KEY UPDATE`;
              if (row === undefined || !row.removed) return { _tag: "gone" } as const;
              if (!row.allowed) return { _tag: "forbidden" } as const;
              if (row.phase === "deleting" && row.fresh)
                return { _tag: "underway", stopped: null } as const;
              const id = RemovalFenceId.make(`rmv_${crypto.randomUUID()}`);
              yield* sql`UPDATE projects SET removal_phase = 'deleting', removal_id = ${id}, removal_since = now()
                WHERE id = ${projectId}`;
              return { _tag: "finish", id } as const;
            }),
          )
          .pipe(Effect.orDie);
      });

      const finishPurge = Effect.fn("RemovalFencesRepo.finishPurge")(function* (
        id: ProjectId,
        mark: RemovalFenceId,
        userId: string,
      ) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const held = yield* sql`SELECT id FROM projects
                WHERE id = ${id} AND removal_id = ${mark} AND removal_phase = 'deleting'
                  AND removal_fence_fresh(removal_since) FOR UPDATE`;
              if (held.length === 0) return false;
              const snapshots = yield* sql<{ readonly id: string }>`SELECT id FROM context_snapshots
                WHERE id IN (SELECT context_snapshot_id FROM agent_sessions WHERE project_id = ${id}) FOR UPDATE`;
              yield* audited(id, userId, "project.purged");
              yield* sql`DELETE FROM previews WHERE project_id = ${id}`;
              // Inherited capture objects still need their owner's register/retention guard.
              yield* sql`UPDATE worktree_chain SET orphaned = true, head_capture = NULL, head_n = -1,
                head_epoch = 0, guard = guard + 1 WHERE worktree_id IN (SELECT id FROM worktrees WHERE project_id = ${id})`;
              yield* sql`DELETE FROM projects WHERE id = ${id}`;
              for (const snapshot of snapshots) {
                yield* sql`DELETE FROM context_snapshots WHERE id = ${snapshot.id}
                  AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE context_snapshot_id = ${snapshot.id})`;
              }
              yield* notifyEvent(sql, { type: "project", projectId: id });
              return true;
            }),
          )
          .pipe(Effect.orDie);
      });

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
              if (row.kind === "project") {
                const removed =
                  yield* sql`SELECT id FROM projects WHERE id = ${row.id} AND removed_at IS NOT NULL FOR NO KEY UPDATE`;
                if (removed.length > 0) return { _tag: "gone" } as const;
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
          ${row.kind === "project" ? sql`, removed_at = now()` : sql``}
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
          WHERE id = ${row.id} AND removal_id = ${id}
            ${row.kind === "project" ? sql`AND removal_phase = 'checking'` : sql``}`.pipe(
          Effect.orDie,
        );
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
        keep,
        restore,
        takePurge,
        finishPurge,
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
