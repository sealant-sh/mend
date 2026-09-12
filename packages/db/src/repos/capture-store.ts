import { PgClient } from "@effect/sql-pg";
import type { WorktreeId } from "@mend/domain";
import { asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  type CaptureGitFsck,
  type CaptureKind,
  type CaptureRow,
  type CaptureSummaryRow,
  type CaptureSummaryState,
  type PackClass,
  type PackRow,
  type PackState,
  captures,
  captureSummaries,
  packs,
  worktreeChain,
} from "../schema/workbench.ts";

/**
 * The capture store's pointers (docs/adr/0002-session-capture-store.md "Postgres schema"):
 * leases, the chain head, capture rows, packs and summaries. Every write below is ONE
 * statement — no advisory locks, no session settings, no multi-statement transactions — so it
 * behaves identically through transaction-mode pooling and Hyperdrive. The row lock a concurrent
 * writer waits on re-evaluates the WHERE, which is the whole serialiser.
 */

/** 409 `worktree_leased`: someone holds the worktree and the lease has not expired. */
export class WorktreeLeasedError extends Schema.TaggedErrorClass<WorktreeLeasedError>()(
  "WorktreeLeasedError",
  { worktreeId: Schema.String },
) {}

export const CaptureConflictReason = Schema.Literals(["stale_epoch", "wrong_parent", "head_moved"]);
export type CaptureConflictReason = typeof CaptureConflictReason.Type;

/** 409 on register: the CAS did not match; `reason` is the diagnosis after the fact. */
export class CaptureConflictError extends Schema.TaggedErrorClass<CaptureConflictError>()(
  "CaptureConflictError",
  { worktreeId: Schema.String, n: Schema.Int, reason: CaptureConflictReason },
) {}

/** 409 on summary: the capture is not the chain head (or never landed). */
export class SummaryRejectedError extends Schema.TaggedErrorClass<SummaryRejectedError>()(
  "SummaryRejectedError",
  { worktreeId: Schema.String, captureId: Schema.String },
) {}

export interface RegisterCapture {
  readonly worktreeId: WorktreeId;
  /** sha256 of the manifest bytes. */
  readonly id: string;
  readonly n: number;
  readonly parent: string | null;
  readonly epoch: number;
  readonly seq: bigint;
  readonly kind: CaptureKind;
  readonly manifestKey: string;
  readonly sections: unknown;
  readonly gitFsck: CaptureGitFsck;
}

export interface WorktreeLease {
  readonly worktreeId: WorktreeId;
  readonly executorId: string | null;
  readonly epoch: number;
  readonly expiresAt: Date | null;
  /** `expires_at > now()` as the database sees it. */
  readonly live: boolean;
}

export interface ChainHead {
  readonly worktreeId: WorktreeId;
  readonly headN: number;
  readonly headEpoch: number;
  /** Null until capture 0 registers. */
  readonly head: CaptureRow | null;
}

export interface PackRecord {
  readonly key: string;
  readonly class: PackClass;
  readonly bytes: number;
  readonly worktreeId: WorktreeId | null;
  readonly epoch: number | null;
  readonly platform: string | null;
}

/** Lease TTL (ADR-0002 "Decisions made here" 8): heartbeat every 10 s against 30 s. */
export const LEASE_TTL_SECONDS = 30;

export class CaptureStoreRepo extends Context.Service<
  CaptureStoreRepo,
  {
    /** Lease + chain rows for a worktree (idempotent); the worktree row must exist. */
    readonly init: (worktreeId: WorktreeId) => Effect.Effect<void>;
    /**
     * Start, pickup or replacement: bump the epoch and fence the chain in one statement. Fails
     * `WorktreeLeasedError` while another holder's lease is live.
     */
    readonly claim: (
      worktreeId: WorktreeId,
      executorId: string,
      ttlSeconds?: number,
    ) => Effect.Effect<{ readonly epoch: number }, WorktreeLeasedError>;
    /** Renew under the holder's epoch; false = the lease is gone (stop shipping, pause). */
    readonly heartbeat: (
      worktreeId: WorktreeId,
      epoch: number,
      ttlSeconds?: number,
    ) => Effect.Effect<boolean>;
    /**
     * The only write that advances truth. `lostAck` is true when the chain already stood at
     * `n` with this very capture id — a retry after a lost acknowledgement, not a conflict.
     */
    readonly register: (
      capture: RegisterCapture,
    ) => Effect.Effect<{ readonly lostAck: boolean }, CaptureConflictError>;
    /** `final` capture, session end: the next claimer may take the worktree at once. */
    readonly release: (worktreeId: WorktreeId, epoch: number) => Effect.Effect<boolean>;
    /** Accept a posted change summary only against the chain head. */
    readonly acceptSummary: (
      worktreeId: WorktreeId,
      captureId: string,
      key: string,
    ) => Effect.Effect<void, SummaryRejectedError>;
    /** The observed pass stamps the summary after recomputing it on a runner. */
    readonly setSummaryState: (
      captureId: string,
      state: CaptureSummaryState,
    ) => Effect.Effect<boolean>;
    readonly leaseOf: (worktreeId: WorktreeId) => Effect.Effect<WorktreeLease | null>;
    readonly headOf: (worktreeId: WorktreeId) => Effect.Effect<ChainHead | null>;
    /** Every registered capture of the worktree, oldest first. */
    readonly listChain: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<CaptureRow>>;
    readonly captureById: (captureId: string) => Effect.Effect<CaptureRow | null>;
    /** Upsert pack rows (state `uploaded` unless already further along). */
    readonly recordPacks: (records: ReadonlyArray<PackRecord>) => Effect.Effect<void>;
    /** The posted summary row for a capture, if one was accepted. */
    readonly summaryOf: (captureId: string) => Effect.Effect<CaptureSummaryRow | null>;
    /** Every chain (retention walks them all; liveness is chain rows, never bucket listings). */
    readonly listChains: () => Effect.Effect<
      ReadonlyArray<{
        readonly worktreeId: WorktreeId;
        readonly headCapture: string | null;
        readonly headN: number;
      }>
    >;
    /** Drop thinned capture rows; `checkpoints.capture_id` nulls and summaries cascade. */
    readonly deleteCaptures: (
      worktreeId: WorktreeId,
      captureIds: ReadonlyArray<string>,
    ) => Effect.Effect<number>;
    readonly listPacks: (state?: PackState) => Effect.Effect<ReadonlyArray<PackRow>>;
    readonly setPackState: (
      packIds: ReadonlyArray<string>,
      state: PackState,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/CaptureStoreRepo") {}

const digestOf = (key: string) => key.slice(key.lastIndexOf("/") + 1).replace(/\.idx$/, "");

export const CaptureStoreRepoLive: Layer.Layer<
  CaptureStoreRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  CaptureStoreRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const sql = yield* PgClient.PgClient;

    const init = Effect.fn("CaptureStoreRepo.init")(function* (worktreeId: WorktreeId) {
      yield* sql`
        INSERT INTO worktree_leases (worktree_id) VALUES (${worktreeId})
        ON CONFLICT (worktree_id) DO NOTHING`.pipe(Effect.orDie);
      yield* sql`
        INSERT INTO worktree_chain (worktree_id) VALUES (${worktreeId})
        ON CONFLICT (worktree_id) DO NOTHING`.pipe(Effect.orDie);
    });

    const claim = Effect.fn("CaptureStoreRepo.claim")(function* (
      worktreeId: WorktreeId,
      executorId: string,
      ttlSeconds: number = LEASE_TTL_SECONDS,
    ) {
      // A concurrent claimer re-evaluates WHERE after the row lock; the chain learns the new
      // epoch in the same statement, so a stale register cannot land between this claim and
      // the new executor's first register.
      const rows = yield* sql<{ readonly epoch: number }>`
        WITH l AS (
          UPDATE worktree_leases
             SET executor_id = ${executorId},
                 epoch = epoch + 1,
                 expires_at = now() + make_interval(secs => ${ttlSeconds})
           WHERE worktree_id = ${worktreeId}
             AND (expires_at IS NULL OR expires_at < now())
           RETURNING epoch
        )
        UPDATE worktree_chain ch
           SET head_epoch = l.epoch
          FROM l
         WHERE ch.worktree_id = ${worktreeId}
         RETURNING l.epoch::int AS epoch`.pipe(Effect.orDie);
      const row = rows[0];
      if (row === undefined) return yield* new WorktreeLeasedError({ worktreeId });
      return { epoch: Number(row.epoch) };
    });

    const heartbeat = Effect.fn("CaptureStoreRepo.heartbeat")(function* (
      worktreeId: WorktreeId,
      epoch: number,
      ttlSeconds: number = LEASE_TTL_SECONDS,
    ) {
      const rows = yield* sql<{ readonly worktree_id: string }>`
        UPDATE worktree_leases
           SET expires_at = now() + make_interval(secs => ${ttlSeconds})
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch}
         RETURNING worktree_id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const register = Effect.fn("CaptureStoreRepo.register")(function* (capture: RegisterCapture) {
      // The CAS joins the live lease row; the captures row exists only if the CAS matched.
      // `head_capture IS NOT DISTINCT FROM $parent` is the wrong-parent check (NULL for n = 0).
      const rows = yield* sql<{ readonly id: string }>`
        WITH ch AS (
          UPDATE worktree_chain
             SET head_n = ${capture.n}, head_capture = ${capture.id}, head_epoch = ${capture.epoch}
           WHERE worktree_id = ${capture.worktreeId}
             AND head_n = ${capture.n} - 1
             AND head_capture IS NOT DISTINCT FROM ${capture.parent}
             AND ${capture.epoch} = (
               SELECT epoch FROM worktree_leases
                WHERE worktree_id = ${capture.worktreeId} AND expires_at > now())
           RETURNING worktree_id
        )
        INSERT INTO captures (id, worktree_id, n, parent, epoch, seq, kind, manifest_key,
                              sections, git_fsck)
        SELECT ${capture.id}, ${capture.worktreeId}, ${capture.n}, ${capture.parent},
               ${capture.epoch}, ${capture.seq.toString()}::bigint, ${capture.kind},
               ${capture.manifestKey}, ${JSON.stringify(capture.sections)}::jsonb,
               ${capture.gitFsck}
          FROM ch
        RETURNING id`.pipe(Effect.orDie);
      if (rows.length > 0) return { lostAck: false };
      // Zero rows: diagnose. Same n, same id = a retry after a lost ack.
      const [existing] = yield* sql<{
        readonly id: string;
        readonly head_n: number;
        readonly head_capture: string | null;
        readonly lease_epoch: number | null;
      }>`
        SELECT c.id,
               ch.head_n,
               ch.head_capture,
               (SELECT epoch::int FROM worktree_leases
                 WHERE worktree_id = ${capture.worktreeId} AND expires_at > now()) AS lease_epoch
          FROM worktree_chain ch
          LEFT JOIN captures c
            ON c.worktree_id = ch.worktree_id AND c.n = ${capture.n}
         WHERE ch.worktree_id = ${capture.worktreeId}`.pipe(Effect.orDie);
      if (existing !== undefined && existing.id === capture.id) return { lostAck: true };
      const reason: CaptureConflictReason =
        existing === undefined || existing.lease_epoch === null
          ? "stale_epoch"
          : Number(existing.lease_epoch) !== capture.epoch
            ? "stale_epoch"
            : Number(existing.head_n) !== capture.n - 1
              ? "head_moved"
              : "wrong_parent";
      return yield* new CaptureConflictError({
        worktreeId: capture.worktreeId,
        n: capture.n,
        reason,
      });
    });

    const release = Effect.fn("CaptureStoreRepo.release")(function* (
      worktreeId: WorktreeId,
      epoch: number,
    ) {
      const rows = yield* sql<{ readonly worktree_id: string }>`
        UPDATE worktree_leases
           SET expires_at = now()
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch}
         RETURNING worktree_id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const acceptSummary = Effect.fn("CaptureStoreRepo.acceptSummary")(function* (
      worktreeId: WorktreeId,
      captureId: string,
      key: string,
    ) {
      const rows = yield* sql<{ readonly capture_id: string }>`
        INSERT INTO capture_summaries (capture_id, worktree_id, key, state)
        SELECT ${captureId}, ${worktreeId}, ${key}, 'claimed'
          FROM worktree_chain
         WHERE worktree_id = ${worktreeId} AND head_capture = ${captureId}
        ON CONFLICT (capture_id) DO UPDATE
           SET key = EXCLUDED.key, state = 'claimed', updated_at = now()
        RETURNING capture_id`.pipe(Effect.orDie);
      if (rows.length === 0) return yield* new SummaryRejectedError({ worktreeId, captureId });
    });

    const setSummaryState = Effect.fn("CaptureStoreRepo.setSummaryState")(function* (
      captureId: string,
      state: CaptureSummaryState,
    ) {
      const rows = yield* sql<{ readonly capture_id: string }>`
        UPDATE capture_summaries SET state = ${state}, updated_at = now()
         WHERE capture_id = ${captureId}
         RETURNING capture_id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const leaseOf = Effect.fn("CaptureStoreRepo.leaseOf")(function* (worktreeId: WorktreeId) {
      const [row] = yield* sql<{
        readonly worktree_id: WorktreeId;
        readonly executor_id: string | null;
        readonly epoch: number;
        readonly expires_at: Date | null;
        readonly live: boolean;
      }>`
        SELECT worktree_id, executor_id, epoch::int AS epoch, expires_at,
               (expires_at IS NOT NULL AND expires_at > now()) AS live
          FROM worktree_leases WHERE worktree_id = ${worktreeId}`.pipe(Effect.orDie);
      return row === undefined
        ? null
        : {
            worktreeId: row.worktree_id,
            executorId: row.executor_id,
            epoch: Number(row.epoch),
            expiresAt: row.expires_at,
            live: row.live,
          };
    });

    const headOf = Effect.fn("CaptureStoreRepo.headOf")(function* (worktreeId: WorktreeId) {
      const [chain] = yield* sql<{
        readonly worktree_id: WorktreeId;
        readonly head_capture: string | null;
        readonly head_n: number;
        readonly head_epoch: number;
      }>`
        SELECT worktree_id, head_capture, head_n, head_epoch::int AS head_epoch
          FROM worktree_chain WHERE worktree_id = ${worktreeId}`.pipe(Effect.orDie);
      if (chain === undefined) return null;
      const head = chain.head_capture === null ? null : yield* captureById(chain.head_capture);
      return {
        worktreeId: chain.worktree_id,
        headN: Number(chain.head_n),
        headEpoch: Number(chain.head_epoch),
        head,
      };
    });

    const listChain = Effect.fn("CaptureStoreRepo.listChain")(function* (worktreeId: WorktreeId) {
      return yield* db
        .select()
        .from(captures)
        .where(eq(captures.worktreeId, worktreeId))
        .orderBy(asc(captures.n))
        .pipe(Effect.orDie);
    });

    const captureById = Effect.fn("CaptureStoreRepo.captureById")(function* (captureId: string) {
      const [row] = yield* db
        .select()
        .from(captures)
        .where(eq(captures.id, captureId))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const recordPacks = Effect.fn("CaptureStoreRepo.recordPacks")(function* (
      records: ReadonlyArray<PackRecord>,
    ) {
      if (records.length === 0) return;
      yield* db
        .insert(packs)
        .values(
          records.map((record) => ({
            id: digestOf(record.key),
            key: record.key,
            class: record.class,
            bytes: record.bytes,
            worktreeId: record.worktreeId,
            epoch: record.epoch,
            platform: record.platform,
          })),
        )
        .onConflictDoNothing({ target: packs.id })
        .pipe(Effect.orDie);
    });

    const summaryOf = Effect.fn("CaptureStoreRepo.summaryOf")(function* (captureId: string) {
      const [row] = yield* db
        .select()
        .from(captureSummaries)
        .where(eq(captureSummaries.captureId, captureId))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const listChains = Effect.fn("CaptureStoreRepo.listChains")(function* () {
      const rows = yield* db
        .select({
          worktreeId: worktreeChain.worktreeId,
          headCapture: worktreeChain.headCapture,
          headN: worktreeChain.headN,
        })
        .from(worktreeChain)
        .pipe(Effect.orDie);
      return rows.map((row) => ({
        worktreeId: row.worktreeId,
        headCapture: row.headCapture,
        headN: Number(row.headN),
      }));
    });

    const deleteCaptures = Effect.fn("CaptureStoreRepo.deleteCaptures")(function* (
      worktreeId: WorktreeId,
      captureIds: ReadonlyArray<string>,
    ) {
      if (captureIds.length === 0) return 0;
      // Never the head, whatever the caller computed: the chain pointer stays consistent.
      const rows = yield* sql<{ readonly id: string }>`
        DELETE FROM captures c
         USING worktree_chain ch
         WHERE c.worktree_id = ${worktreeId}
           AND ch.worktree_id = c.worktree_id
           AND c.id <> ch.head_capture
           AND c.id IN ${sql.in([...captureIds])}
         RETURNING c.id`.pipe(Effect.orDie);
      return rows.length;
    });

    const listPacks = Effect.fn("CaptureStoreRepo.listPacks")(function* (state?: PackState) {
      const query = db.select().from(packs);
      const rows = yield* (state === undefined ? query : query.where(eq(packs.state, state))).pipe(
        Effect.orDie,
      );
      return rows;
    });

    const setPackState = Effect.fn("CaptureStoreRepo.setPackState")(function* (
      packIds: ReadonlyArray<string>,
      state: PackState,
    ) {
      if (packIds.length === 0) return;
      yield* db
        .update(packs)
        .set({ state, updatedAt: new Date() })
        .where(inArray(packs.id, [...packIds]))
        .pipe(Effect.orDie);
    });

    return {
      init,
      claim,
      heartbeat,
      register,
      release,
      acceptSummary,
      setSummaryState,
      leaseOf,
      headOf,
      listChain,
      captureById,
      recordPacks,
      summaryOf,
      listChains,
      deleteCaptures,
      listPacks,
      setPackState,
    };
  }),
);
