import { PgClient } from "@effect/sql-pg";
import { SessionId, WorktreeId, type ProjectId, type Sha } from "@mend/domain";
import { Worktree, WorktreeHandoff } from "@mend/domain/workbench";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { agentSessions, worktrees } from "../schema/workbench.ts";

export class WorktreeNotFoundError extends Schema.TaggedError<WorktreeNotFoundError>()(
  "WorktreeNotFoundError",
  {
    id: Schema.String,
  },
) {}

export interface NewWorktreeRow {
  /** Caller-supplied: the engine derives the anonymous directory/branch from it. */
  readonly id: WorktreeId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly directory: string;
  readonly branch: string;
  readonly baseSha: Sha;
  readonly baseRef: string | null;
  readonly handoff: WorktreeHandoff | null;
}

/** Session states that count as live for removal guards and follow-up targeting. */
const LIVE_SESSION_STATUSES = ["starting", "running", "waiting", "idle"] as const;

/**
 * The index of durable worktree containers (plan §5.5/§5.6) — table `worktrees`.
 * The git worktree itself lives in the project store; this row carries identity
 * (display name vs immutable directory), the base facts, and the membership key
 * sessions/changes/checkpoints hang off.
 */
export class WorktreesRepo extends Context.Service<
  WorktreesRepo,
  {
    readonly create: (worktree: NewWorktreeRow) => Effect.Effect<Worktree>;
    readonly byId: (id: WorktreeId) => Effect.Effect<Worktree, WorktreeNotFoundError>;
    readonly byName: (projectId: ProjectId, name: string) => Effect.Effect<Worktree | null>;
    readonly byHandoffCheckpoint: (
      projectId: ProjectId,
      checkpoint: Sha,
    ) => Effect.Effect<Worktree | null>;
    /**
     * The delta pack every handoff seed names. Retention keeps each while its row stands: before
     * capture 0 is laid down nothing else names it, and capture 0 keeps it after.
     */
    readonly handoffPacks: () => Effect.Effect<ReadonlyArray<string>>;
    /** Directory names are the store-path key pre-pivot rows are matched by. */
    readonly byDirectory: (
      projectId: ProjectId,
      directory: string,
    ) => Effect.Effect<Worktree | null>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<Worktree>>;
    /** Hot-claim reset: the pooled worktree re-bases to what the claim asked for. */
    readonly setBase: (id: WorktreeId, baseSha: Sha, baseRef: string | null) => Effect.Effect<void>;
    /** Display identity rename (name + branch); the directory never moves. */
    readonly rename: (id: WorktreeId, name: string, branch: string) => Effect.Effect<void>;
    readonly remove: (id: WorktreeId) => Effect.Effect<void>;
    /**
     * The change's owner (docs/adr/0007-landing.md, "Who lands"), as the first session's insert
     * stored it; null for a worktree with none, or one that is gone.
     */
    readonly changeOwnerOf: (id: WorktreeId) => Effect.Effect<string | null>;
    /**
     * The follow-up target resolver: the newest live conversation in the
     * worktree, or null when none is live.
     */
    readonly newestLiveSessionId: (id: WorktreeId) => Effect.Effect<SessionId | null>;
  }
>()("@mend/db/WorktreesRepo") {}

const decodeHandoff = Schema.decodeUnknownSync(WorktreeHandoff);

const toWorktree = ({
  removalPhase: _phase,
  removalId: _id,
  removalSince: _since,
  ...row
}: typeof worktrees.$inferSelect): Worktree =>
  new Worktree({ ...row, handoff: row.handoff === null ? null : decodeHandoff(row.handoff) });

// Compile-time seam tripwire (same discipline as SessionsRepo): a column added
// to `worktrees` must land in @mend/domain's Worktree in the same change. A removal's mark is the
// one exception: only RemovalFencesRepo reads it.
type WorktreeRowShape = Omit<
  typeof worktrees.$inferSelect,
  "removalPhase" | "removalId" | "removalSince"
>;
type ExactKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
  ? true
  : never;
const worktreeSeamIntact: ExactKeys<WorktreeRowShape, Worktree> = true;
void worktreeSeamIntact;

export const WorktreesRepoLive: Layer.Layer<WorktreesRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    WorktreesRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const pg = yield* PgClient.PgClient;

      const create = Effect.fn("WorktreesRepo.create")(function* (worktree: NewWorktreeRow) {
        const [row] = yield* db.insert(worktrees).values(worktree).returning().pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("worktree insert returned no row");
        yield* notifyEvent(pg, {
          type: "worktree",
          worktreeId: row.id,
          projectId: row.projectId,
        });
        return toWorktree(row);
      });

      const byId = Effect.fn("WorktreesRepo.byId")(function* (id: WorktreeId) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(eq(worktrees.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        if (row === undefined) return yield* new WorktreeNotFoundError({ id });
        return toWorktree(row);
      });

      const byName = Effect.fn("WorktreesRepo.byName")(function* (
        projectId: ProjectId,
        name: string,
      ) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(and(eq(worktrees.projectId, projectId), eq(worktrees.name, name)))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toWorktree(row);
      });

      const byHandoffCheckpoint = Effect.fn("WorktreesRepo.byHandoffCheckpoint")(function* (
        projectId: ProjectId,
        checkpoint: Sha,
      ) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(
            and(
              eq(worktrees.projectId, projectId),
              sql`${worktrees.handoff}->>'checkpoint' = ${checkpoint}`,
            ),
          )
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toWorktree(row);
      });

      const handoffPacks = Effect.fn("WorktreesRepo.handoffPacks")(function* () {
        const rows = yield* db
          .select({ deltaPack: sql<string>`${worktrees.handoff}->>'deltaPack'` })
          .from(worktrees)
          .where(isNotNull(worktrees.handoff))
          .pipe(Effect.orDie);
        return rows.map((row) => row.deltaPack);
      });

      const byDirectory = Effect.fn("WorktreesRepo.byDirectory")(function* (
        projectId: ProjectId,
        directory: string,
      ) {
        const [row] = yield* db
          .select()
          .from(worktrees)
          .where(and(eq(worktrees.projectId, projectId), eq(worktrees.directory, directory)))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toWorktree(row);
      });

      const listForProject = Effect.fn("WorktreesRepo.listForProject")(function* (
        projectId: ProjectId,
      ) {
        const rows = yield* db
          .select()
          .from(worktrees)
          .where(eq(worktrees.projectId, projectId))
          .orderBy(desc(worktrees.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toWorktree);
      });

      const setBase = Effect.fn("WorktreesRepo.setBase")(function* (
        id: WorktreeId,
        baseSha: Sha,
        baseRef: string | null,
      ) {
        yield* db
          .update(worktrees)
          .set({ baseSha, baseRef, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(worktrees.id, id))
          .pipe(Effect.orDie);
      });

      const rename = Effect.fn("WorktreesRepo.rename")(function* (
        id: WorktreeId,
        name: string,
        branch: string,
      ) {
        const [row] = yield* db
          .update(worktrees)
          .set({ name, branch, updatedAt: yield* DateTime.nowAsDate })
          .where(eq(worktrees.id, id))
          .returning({ projectId: worktrees.projectId })
          .pipe(Effect.orDie);
        if (row !== undefined) {
          yield* notifyEvent(pg, { type: "worktree", worktreeId: id, projectId: row.projectId });
        }
      });

      const remove = Effect.fn("WorktreesRepo.remove")(function* (id: WorktreeId) {
        const [row] = yield* db
          .delete(worktrees)
          .where(eq(worktrees.id, id))
          .returning({ projectId: worktrees.projectId })
          .pipe(Effect.orDie);
        if (row !== undefined) {
          yield* notifyEvent(pg, { type: "worktree", worktreeId: id, projectId: row.projectId });
        }
      });

      const changeOwnerOf = Effect.fn("WorktreesRepo.changeOwnerOf")(function* (id: WorktreeId) {
        const [row] = yield* db
          .select({ owner: worktrees.changeOwnerUserId })
          .from(worktrees)
          .where(eq(worktrees.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row?.owner ?? null;
      });

      const newestLiveSessionId = Effect.fn("WorktreesRepo.newestLiveSessionId")(function* (
        id: WorktreeId,
      ) {
        const [row] = yield* db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.worktreeId, id),
              inArray(agentSessions.status, [...LIVE_SESSION_STATUSES]),
            ),
          )
          .orderBy(desc(agentSessions.createdAt), asc(agentSessions.id))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : SessionId.make(row.id);
      });

      return {
        create,
        byId,
        byName,
        byHandoffCheckpoint,
        handoffPacks,
        byDirectory,
        listForProject,
        setBase,
        rename,
        remove,
        changeOwnerOf,
        newestLiveSessionId,
      };
    }),
  );
