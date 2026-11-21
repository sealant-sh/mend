import {
  CheckpointId,
  CheckpointRestoreId,
  type SealantRunId,
  type SessionId,
  type Sha,
  type WorktreeId,
} from "@mend/domain";
import {
  Checkpoint,
  CheckpointRestore,
  CheckpointSource,
  type CheckpointTrigger,
} from "@mend/domain/workbench";
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { checkpointRestoreNotes, checkpointRestores, checkpoints } from "../schema/workbench.ts";

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
  /** Taken during a Stop from the Stop's own flush; absent when observed for itself. */
  readonly source?: CheckpointSource | null;
}

/** A restore to record: the three checkpoints it names, and the sessions whose agents it tells. */
export interface NewCheckpointRestore {
  readonly worktreeId: WorktreeId;
  readonly sessionId: SessionId;
  readonly actorId: string;
  readonly target: Checkpoint;
  readonly saved: Checkpoint;
  readonly result: Checkpoint;
  /** Every session in the worktree: each owes its agent a note on its next message. */
  readonly notify: ReadonlyArray<SessionId>;
}

/**
 * `(worktree_id, ordinal)` was taken between the caller's read and its insert — another writer
 * snapshotted the same worktree at the same ordinal. `existing` is that writer's row, so the
 * caller can answer with it when it records the same snapshot, or re-read and take the next
 * ordinal. Capture mode (ADR-0002) runs without the advisory lock, so this is the backstop.
 */
export class CheckpointOrdinalTakenError extends Schema.TaggedError<CheckpointOrdinalTakenError>()(
  "CheckpointOrdinalTakenError",
  { worktreeId: Schema.String, ordinal: Schema.Int, existing: Checkpoint },
) {}

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
    /**
     * One row per `(worktree_id, ordinal)`: the insert is `ON CONFLICT DO NOTHING`, and a
     * conflict fails `CheckpointOrdinalTakenError` with the row that got there first — never a
     * unique-violation defect.
     */
    readonly create: (
      checkpoint: NewCheckpoint,
    ) => Effect.Effect<Checkpoint, CheckpointOrdinalTakenError>;
    readonly byId: (id: CheckpointId) => Effect.Effect<Checkpoint | null>;
    /** Internal capture provenance for this exact checkpoint/worktree; null when not retained. */
    readonly captureIdOf: (
      id: CheckpointId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<string | null>;
    readonly byOrdinal: (
      worktreeId: WorktreeId,
      ordinal: number,
    ) => Effect.Effect<Checkpoint | null>;
    readonly listForWorktree: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<Checkpoint>>;
    readonly latestForWorktree: (worktreeId: WorktreeId) => Effect.Effect<Checkpoint | null>;
    /** The worktree's newest checkpoint taken at or before `at`: what it held then. */
    readonly latestForWorktreeAt: (
      worktreeId: WorktreeId,
      at: Date,
    ) => Effect.Effect<Checkpoint | null>;
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
    /** Record a restore (SLNT-1259) and a waiting note for each session it names. */
    readonly recordRestore: (restore: NewCheckpointRestore) => Effect.Effect<CheckpointRestore>;
    /** The worktree's restores, oldest first. */
    readonly restoresForWorktree: (
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<CheckpointRestore>>;
    /**
     * The restores whose note rides on `carrier` (a turn's id, a terminal message's key), oldest
     * first: every note of the session still waiting is given to it first. Asking again with the
     * same carrier answers the same restores, so a turn sent again carries its notes again.
     */
    readonly takeRestoreNotes: (
      sessionId: SessionId,
      carrier: string,
    ) => Effect.Effect<ReadonlyArray<CheckpointRestore>>;
  }
>()("@mend/db/CheckpointsRepo") {}

const toRestore = (row: typeof checkpointRestores.$inferSelect): CheckpointRestore =>
  new CheckpointRestore({
    id: row.id,
    worktreeId: row.worktreeId,
    sessionId: row.sessionId,
    actorId: row.actorId,
    target: { id: row.targetCheckpointId, ordinal: row.targetOrdinal },
    saved: { id: row.savedCheckpointId, ordinal: row.savedOrdinal },
    result: { id: row.resultCheckpointId, ordinal: row.resultOrdinal },
    createdAt: row.createdAt,
  });

const toCheckpoint = ({
  sourceKind,
  sourceCaptureN,
  sourceObservedAt,
  ...row
}: typeof checkpoints.$inferSelect): Checkpoint =>
  new Checkpoint({
    ...row,
    ...(sourceKind === null || sourceObservedAt === null
      ? {}
      : {
          source: new CheckpointSource({
            kind: sourceKind,
            captureN: sourceCaptureN,
            observedAt: sourceObservedAt,
          }),
        }),
  });

export const CheckpointsRepoLive: Layer.Layer<CheckpointsRepo, never, MendDB> = Layer.effect(
  CheckpointsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const byId = Effect.fn("CheckpointsRepo.byId")(function* (id: CheckpointId) {
      const [row] = yield* db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toCheckpoint(row);
    });

    const captureIdOf = Effect.fn("CheckpointsRepo.captureIdOf")(function* (
      id: CheckpointId,
      worktreeId: WorktreeId,
    ) {
      const [row] = yield* db
        .select({ captureId: checkpoints.captureId })
        .from(checkpoints)
        .where(and(eq(checkpoints.id, id), eq(checkpoints.worktreeId, worktreeId)))
        .limit(1)
        .pipe(Effect.orDie);
      return row?.captureId ?? null;
    });

    const byOrdinal = Effect.fn("CheckpointsRepo.byOrdinal")(function* (
      worktreeId: WorktreeId,
      ordinal: number,
    ) {
      const [row] = yield* db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.worktreeId, worktreeId), eq(checkpoints.ordinal, ordinal)))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toCheckpoint(row);
    });

    const create = Effect.fn("CheckpointsRepo.create")(function* (checkpoint: NewCheckpoint) {
      const [created] = yield* db
        .insert(checkpoints)
        .values({
          id: CheckpointId.make(crypto.randomUUID()),
          worktreeId: checkpoint.worktreeId,
          sessionId: checkpoint.sessionId,
          ordinal: checkpoint.ordinal,
          ref: checkpoint.ref,
          sha: checkpoint.sha,
          sealantRunId: checkpoint.sealantRunId,
          seq: checkpoint.seq,
          trigger: checkpoint.trigger,
          captureId: checkpoint.captureId ?? null,
          sourceKind: checkpoint.source?.kind ?? null,
          sourceCaptureN: checkpoint.source?.captureN ?? null,
          sourceObservedAt: checkpoint.source?.observedAt ?? null,
        })
        .onConflictDoNothing({ target: [checkpoints.worktreeId, checkpoints.ordinal] })
        .returning()
        .pipe(Effect.orDie);
      if (created !== undefined) return toCheckpoint(created);
      const existing = yield* byOrdinal(checkpoint.worktreeId, checkpoint.ordinal);
      if (existing === null) return yield* Effect.die("checkpoint conflict returned no row");
      return yield* new CheckpointOrdinalTakenError({
        worktreeId: checkpoint.worktreeId,
        ordinal: checkpoint.ordinal,
        existing,
      });
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

    const latestForWorktreeAt = Effect.fn("CheckpointsRepo.latestForWorktreeAt")(function* (
      worktreeId: WorktreeId,
      at: Date,
    ) {
      const [row] = yield* db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.worktreeId, worktreeId), lte(checkpoints.createdAt, at)))
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

    const recordRestore = Effect.fn("CheckpointsRepo.recordRestore")(function* (
      restore: NewCheckpointRestore,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .insert(checkpointRestores)
              .values({
                id: CheckpointRestoreId.make(crypto.randomUUID()),
                worktreeId: restore.worktreeId,
                sessionId: restore.sessionId,
                actorId: restore.actorId,
                targetCheckpointId: restore.target.id,
                targetOrdinal: restore.target.ordinal,
                savedCheckpointId: restore.saved.id,
                savedOrdinal: restore.saved.ordinal,
                resultCheckpointId: restore.result.id,
                resultOrdinal: restore.result.ordinal,
              })
              .returning();
            if (row === undefined)
              return yield* Effect.die("checkpoint restore insert returned no row");
            if (restore.notify.length > 0)
              yield* tx
                .insert(checkpointRestoreNotes)
                .values(restore.notify.map((sessionId) => ({ restoreId: row.id, sessionId })))
                .onConflictDoNothing();
            return toRestore(row);
          }),
        )
        .pipe(Effect.orDie);
    });

    const restoresForWorktree = Effect.fn("CheckpointsRepo.restoresForWorktree")(function* (
      worktreeId: WorktreeId,
    ) {
      const rows = yield* db
        .select()
        .from(checkpointRestores)
        .where(eq(checkpointRestores.worktreeId, worktreeId))
        .orderBy(asc(checkpointRestores.createdAt), asc(checkpointRestores.id))
        .pipe(Effect.orDie);
      return rows.map(toRestore);
    });

    const takeRestoreNotes = Effect.fn("CheckpointsRepo.takeRestoreNotes")(function* (
      sessionId: SessionId,
      carrier: string,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .update(checkpointRestoreNotes)
              .set({ carrier, deliveredAt: sql`now()` })
              .where(
                and(
                  eq(checkpointRestoreNotes.sessionId, sessionId),
                  isNull(checkpointRestoreNotes.carrier),
                ),
              );
            const carried = tx
              .select({ id: checkpointRestoreNotes.restoreId })
              .from(checkpointRestoreNotes)
              .where(
                and(
                  eq(checkpointRestoreNotes.sessionId, sessionId),
                  eq(checkpointRestoreNotes.carrier, carrier),
                ),
              );
            const rows = yield* tx
              .select()
              .from(checkpointRestores)
              .where(inArray(checkpointRestores.id, carried))
              .orderBy(asc(checkpointRestores.createdAt), asc(checkpointRestores.id));
            return rows.map(toRestore);
          }),
        )
        .pipe(Effect.orDie);
    });

    return {
      create,
      byId,
      captureIdOf,
      byOrdinal,
      listForWorktree,
      latestForWorktree,
      latestForWorktreeAt,
      countForWorktree,
      listForSession,
      withWorktreeLock,
      recordRestore,
      restoresForWorktree,
      takeRestoreNotes,
    };
  }),
);
