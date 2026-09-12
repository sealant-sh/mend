import {
  CheckpointId,
  type SealantRunId,
  type SessionId,
  type Sha,
  type WorktreeId,
} from "@mend/domain";
import { Checkpoint, type CheckpointTrigger } from "@mend/domain/workbench";
import { asc, count, desc, eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { checkpoints } from "../schema/workbench.ts";

export interface NewCheckpoint {
  readonly worktreeId: WorktreeId;
  /** Provenance — the triggering conversation; null for worktree-level triggers. */
  readonly sessionId: SessionId | null;
  readonly ordinal: number;
  readonly ref: string;
  readonly sha: Sha;
  readonly sealantRunId: SealantRunId | null;
  readonly seq: bigint;
  readonly trigger: CheckpointTrigger;
  /** Capture mode (ADR-0002): the registered capture this checkpoint came from. */
  readonly captureId?: string | null;
}

/** Internal wrapper so `withWorktreeLock` can rethrow the body's error unwidened. */
class CheckpointLockBodyError<E> {
  readonly error: E;

  constructor(error: E) {
    this.error = error;
  }
}

/**
 * The checkpoint index (plan §5.6): hidden git ref plus exact record pointer.
 * The refs themselves live in the store's bare repo; this table is how the
 * review picks two of them without touching git. The chain belongs to the
 * worktree — one dense ordinal sequence across every session in it.
 */
export class CheckpointsRepo extends Context.Service<
  CheckpointsRepo,
  {
    readonly create: (checkpoint: NewCheckpoint) => Effect.Effect<Checkpoint>;
    readonly byId: (id: CheckpointId) => Effect.Effect<Checkpoint | null>;
    readonly listForWorktree: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<Checkpoint>>;
    readonly latestForWorktree: (worktreeId: WorktreeId) => Effect.Effect<Checkpoint | null>;
    /** Next ordinal = count; the unique `(worktree_id, ordinal)` index backstops the lock. */
    readonly countForWorktree: (worktreeId: WorktreeId) => Effect.Effect<number>;
    /** Transcript-scoped readers: a session's own snapshots, by provenance. */
    readonly listForSession: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Checkpoint>>;
    /**
     * Serializes concurrent snapshot writers for one worktree (advisory xact
     * lock): two live sessions settling at once must read count/parent and
     * insert atomically, and the git-side `add -A` passes over the shared
     * directory must not interleave.
     */
    readonly withWorktreeLock: <A, E, R>(
      worktreeId: WorktreeId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@mend/db/CheckpointsRepo") {}

const toCheckpoint = (row: typeof checkpoints.$inferSelect): Checkpoint => new Checkpoint(row);

export const CheckpointsRepoLive: Layer.Layer<CheckpointsRepo, never, MendDB> = Layer.effect(
  CheckpointsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const create = Effect.fn("CheckpointsRepo.create")(function* (checkpoint: NewCheckpoint) {
      const [created] = yield* db
        .insert(checkpoints)
        .values({
          id: CheckpointId.make(crypto.randomUUID()),
          ...checkpoint,
          captureId: checkpoint.captureId ?? null,
        })
        .returning()
        .pipe(Effect.orDie);
      if (created === undefined) return yield* Effect.die("checkpoint insert returned no row");
      return toCheckpoint(created);
    });

    const byId = Effect.fn("CheckpointsRepo.byId")(function* (id: CheckpointId) {
      const [row] = yield* db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toCheckpoint(row);
    });

    const listForWorktree = Effect.fn("CheckpointsRepo.listForWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const rows = yield* db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.worktreeId, worktreeId))
        .orderBy(asc(checkpoints.ordinal))
        .pipe(Effect.orDie);
      return rows.map(toCheckpoint);
    });

    const latestForWorktree = Effect.fn("CheckpointsRepo.latestForWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const [row] = yield* db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.worktreeId, worktreeId))
        .orderBy(desc(checkpoints.ordinal))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toCheckpoint(row);
    });

    const countForWorktree = Effect.fn("CheckpointsRepo.countForWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const [row] = yield* db
        .select({ value: count() })
        .from(checkpoints)
        .where(eq(checkpoints.worktreeId, worktreeId))
        .pipe(Effect.orDie);
      return row?.value ?? 0;
    });

    const listForSession = Effect.fn("CheckpointsRepo.listForSession")(function* (
      sessionId: SessionId,
    ) {
      const rows = yield* db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.sessionId, sessionId))
        .orderBy(asc(checkpoints.ordinal))
        .pipe(Effect.orDie);
      return rows.map(toCheckpoint);
    });

    const withWorktreeLock = <A, E, R>(
      worktreeId: WorktreeId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              sql`select pg_advisory_xact_lock(hashtext(${`mend:worktree:${worktreeId}`}))`,
            );
            return yield* effect.pipe(
              Effect.mapError((error) => new CheckpointLockBodyError(error)),
            );
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof CheckpointLockBodyError ? Effect.fail(error.error) : Effect.die(error),
          ),
        );

    return {
      create,
      byId,
      listForWorktree,
      latestForWorktree,
      countForWorktree,
      listForSession,
      withWorktreeLock,
    };
  }),
);
