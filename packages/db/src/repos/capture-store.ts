import { PgClient } from "@effect/sql-pg";
import type { WorktreeId } from "@mend/domain";
import { asc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
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
 *
 * Register and retention meet on `worktree_chain.guard` (migration 0076): a register bumps the
 * guard of every chain whose objects it names, retention bumps a chain's guard when it condemns
 * that chain's objects (`capture_tombstones`), and each writes only while the guard still reads
 * what it read before it looked — so a register never lands on bytes retention is deleting, and
 * retention never deletes bytes a register it did not see has named.
 *
 * Deletion then owns what it condemned (migration 0080): the condemnation takes a claim on every
 * key (`capture_deletion_claims`, one token per condemnation) that lasts until the pass has
 * deleted the bytes and settled the tombstone. A tombstone is permanent: no register ever names a
 * condemned key again (cross-repo decision 6, review 2026-09-28 (3) #2) — a pass that stalled past
 * its claim can still delete whatever sits at that key, so content retention condemned comes back
 * only under a new key (a new generation, `captures/<worktree>/<epoch>/g<n>/…`).
 */

/** 409 `worktree_leased`: someone holds the worktree and the lease has not expired. */
export class WorktreeLeasedError extends Schema.TaggedErrorClass<WorktreeLeasedError>()(
  "WorktreeLeasedError",
  { worktreeId: Schema.String },
) {}

/**
 * `guard_moved`: retention condemned objects of a chain the capture names, or another register
 * named them, after this register read the guards — read them again and retry.
 */
export const CaptureConflictReason = Schema.Literals([
  "stale_epoch",
  "wrong_parent",
  "head_moved",
  "guard_moved",
]);
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
  /**
   * The guard of every chain whose objects the capture names, its own included, as
   * `referenceState` read them before the register checked those objects in the bucket. The
   * CAS lands only while every one still reads so, and bumps each. Absent: the register names
   * only objects written for it (Mend's own capture 0), which no retention pass can have seen.
   */
  readonly guards?: ReadonlyArray<ChainGuard>;
  /**
   * Every key the capture names: the CAS lands only while retention has condemned none of them
   * (`capture_tombstones`). A condemned key is never registered again, whatever became of its
   * bytes since (cross-repo decision 6): a pass that stalled past its claim may still delete
   * them, so bytes uploaded there again are never a capture's.
   */
  readonly names?: ReadonlyArray<string>;
  /**
   * The capture's `final_seal`, validated by the caller (complete, this epoch, this executor,
   * every section observed restorable): the CAS records it when it lands and the lease names
   * `holder` — so a seal exists only for a capture registered on a contiguous chain, by the
   * executor holding the worktree. `executorId` is that executor's launch identity (cross-repo
   * decision 5): the one physical executor the seal speaks for. Absent: the capture seals
   * nothing.
   */
  readonly seal?: {
    readonly executorId: string;
    readonly holder: string;
    /** Where sealantd stamped the seal in its own order, when it did (0087). */
    readonly bootId?: string | null;
    readonly bootGeneration?: number | null;
    readonly observation?: number | null;
  };
  /**
   * Who registers: the lease holder and the physical launch its token names (cross-repo
   * decision 11). The CAS lands only while the live lease names that holder and that launch
   * (or no launch — a lease taken before leases were bound to one). Absent: Mend's own writes
   * under its short `mend:` claim.
   */
  readonly holder?: LeaseHolder;
}

/**
 * A lease holder as the store binds it (cross-repo decision 11, review 2026-09-28 (4) #11): the
 * session (or Mend's `mend:` claim) and the physical launch — the executor's create key — whose
 * token it is. An older launch of the same session is another holder: it never learns, renews or
 * ships under a newer launch's epoch.
 */
export interface LeaseHolder {
  readonly executorId: string;
  readonly launchId: string;
}

/**
 * A completed final flush, as the store holds it (migration 0080): the executor, the epoch it
 * held, and the sealing capture — what "saved" rests on.
 */
export interface SealedCompletion {
  readonly worktreeId: WorktreeId;
  readonly epoch: number;
  readonly executorId: string;
  readonly captureId: string;
  readonly n: number;
  readonly sealedAt: Date;
  /** Where sealantd stamped the seal in its own order; null when it did not. */
  readonly bootId: string | null;
  readonly bootGeneration: number | null;
  readonly observation: number | null;
  /**
   * When every object the sealed capture names was last read back as what its name says, at a
   * moment no upload URL of its epoch could replace one (0089); null or absent: never.
   */
  readonly reverifiedAt?: Date | null;
  /** Why the seal never stands again (0089); null or absent: it may stand. */
  readonly voidReason?: string | null;
}

export interface ChainGuard {
  readonly worktreeId: WorktreeId;
  readonly guard: number;
}

/** What `referenceState` read, in one snapshot. */
export interface ReferenceState {
  /** The guard of every chain asked about that exists. */
  readonly guards: ReadonlyMap<WorktreeId, number>;
  /**
   * The keys asked about that retention condemned. `deleted` once their bytes are gone AND no
   * pass holds a live deletion claim on them: only then may a register bring one back.
   */
  readonly tombstones: ReadonlyArray<{ readonly key: string; readonly deleted: boolean }>;
}

/**
 * A retention pass's hold on what it condemns: `token` names this condemnation (fresh for each),
 * `ttlSeconds` how long the claim lives unless renewed. A lapsed claim is a pass that crashed.
 */
export interface DeletionClaim {
  readonly token: string;
  readonly ttlSeconds: number;
}

export interface WorktreeLease {
  readonly worktreeId: WorktreeId;
  readonly executorId: string | null;
  /**
   * The physical launch the lease is bound to (migration 0085); null for Mend's own `mend:`
   * claims and a lease taken before leases were bound to a launch. Absent reads null.
   */
  readonly launchId?: string | null;
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
     * `WorktreeLeasedError` while another holder's lease is live, and while another executor's
     * lease has lapsed without a `release`: a lapse is a partition until the platform says the
     * executor ended, and that executor may still hold work it has not shipped. The caller
     * confirms the end and releases first (`SessionEngine`); the same executor, or Mend's own
     * short `mend:` claim, may take a lapsed lease again.
     */
    readonly claim: (
      worktreeId: WorktreeId,
      executorId: string,
      ttlSeconds?: number,
      /**
       * The physical launch taking it (cross-repo decision 11): recorded on the lease, and a
       * lapsed lease of the same holder is taken again only by the launch it names (or one it
       * never bound). Absent: Mend's own claims, bound to no launch.
       */
      launchId?: string,
    ) => Effect.Effect<{ readonly epoch: number }, WorktreeLeasedError>;
    /**
     * Renew under the holder's epoch; false = the lease is gone (stop shipping, pause). With
     * `holder`, only while the lease names that holder and that launch (or no launch).
     */
    readonly heartbeat: (
      worktreeId: WorktreeId,
      epoch: number,
      ttlSeconds?: number,
      holder?: LeaseHolder,
    ) => Effect.Effect<boolean>;
    /**
     * The only write that advances truth. `lostAck` is true when the chain already stood at
     * `n` with this very capture id — a retry after a lost acknowledgement, not a conflict.
     */
    readonly register: (
      capture: RegisterCapture,
    ) => Effect.Effect<{ readonly lostAck: boolean }, CaptureConflictError>;
    /**
     * The holder ended (its termination observed, or its final capture registered): the next
     * claimer may take the worktree at once. Clears the holder, so a lapse and a release differ.
     */
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
    /**
     * Mend's own verification of a capture's git section (`index-pack --verify` plus a
     * connectivity walk of the refs it names): `verified`, `failed`, or `unverified` when the
     * check could not run. Pickup and reads prefer the newest `verified` capture (ADR-0002 16).
     */
    readonly setGitFsck: (captureId: string, outcome: CaptureGitFsck) => Effect.Effect<boolean>;
    readonly leaseOf: (worktreeId: WorktreeId) => Effect.Effect<WorktreeLease | null>;
    readonly headOf: (worktreeId: WorktreeId) => Effect.Effect<ChainHead | null>;
    /**
     * The sealed completion of `executorId`'s final flush on this worktree: under `epoch` when
     * given, else the newest epoch it sealed. Null when that executor never registered a sealed
     * capture — then nothing says its final flush completed.
     */
    readonly sealedCompletion: (
      worktreeId: WorktreeId,
      executorId: string,
      epoch?: number,
    ) => Effect.Effect<SealedCompletion | null>;
    /**
     * Upload URLs under `worktreeId`'s `epoch` prefix can write until `expiresAt` (0089, review
     * 2026-09-28 (7) #8): kept as the latest such time. Recorded before the URL is handed out.
     */
    readonly recordPutAuthority: (
      worktreeId: WorktreeId,
      epoch: number,
      expiresAt: Date,
    ) => Effect.Effect<void>;
    /** The latest expiry of an upload URL handed out under that epoch's prefix, or null. */
    readonly putAuthorityUntil: (
      worktreeId: WorktreeId,
      epoch: number,
    ) => Effect.Effect<Date | null>;
    /**
     * Every object the seal's capture names read back as what its name says, starting at `at`:
     * recorded on the seal while it still names that capture.
     */
    readonly markSealReverified: (
      worktreeId: WorktreeId,
      epoch: number,
      captureId: string,
      at: Date,
    ) => Effect.Effect<void>;
    /** An object the seal's capture names read back as other bytes: it never stands again. */
    readonly voidSeal: (
      worktreeId: WorktreeId,
      epoch: number,
      captureId: string,
      reason: string,
    ) => Effect.Effect<void>;
    /** Every registered capture of the worktree, oldest first. */
    readonly listChain: (worktreeId: WorktreeId) => Effect.Effect<ReadonlyArray<CaptureRow>>;
    readonly captureById: (captureId: string) => Effect.Effect<CaptureRow | null>;
    /**
     * Upsert pack rows (state `uploaded` unless already further along). A `retired` row whose
     * content a capture names again under a new key is live again at that key.
     */
    readonly recordPacks: (records: ReadonlyArray<PackRecord>) => Effect.Effect<void>;
    /** The posted summary row for a capture, if one was accepted. */
    readonly summaryOf: (captureId: string) => Effect.Effect<CaptureSummaryRow | null>;
    /** Every chain (retention walks them all; liveness is chain rows, never bucket listings). */
    readonly listChains: () => Effect.Effect<
      ReadonlyArray<{
        readonly worktreeId: WorktreeId;
        readonly headCapture: string | null;
        readonly headN: number;
        /** Read before any row the caller computes liveness from; `condemn` takes it back. */
        readonly guard: number;
      }>
    >;
    /**
     * A register's first read, before it checks the bucket: the guards of the chains owning the
     * objects it names, and which of those objects retention condemned — one snapshot.
     */
    readonly referenceState: (
      worktreeIds: ReadonlyArray<WorktreeId>,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<ReferenceState>;
    /**
     * Retention: tombstone `keys` (objects of `worktreeId`'s chain no row names) while the
     * chain's guard still reads `guard` — no register has named anything of the chain since
     * retention read it — bump the guard, and hold `claim` on every key until
     * `finishDeletion`. False: something moved; delete nothing.
     */
    readonly condemn: (
      worktreeId: WorktreeId,
      guard: number,
      keys: ReadonlyArray<string>,
      claim: DeletionClaim,
    ) => Effect.Effect<boolean>;
    /**
     * Retention, before it deletes: extend every claim `token` holds by `ttlSeconds`. Only while
     * none of them has lapsed — a lapsed one is renewed never, since a register may have brought
     * its key back. The number renewed: fewer than the keys condemned means stop deleting.
     */
    readonly renewDeletion: (token: string, ttlSeconds: number) => Effect.Effect<number>;
    /**
     * Retention, done with one condemnation: the tombstones of `deleted` read deleted (their
     * bytes are gone), and every claim `token` holds ends. A key whose delete failed keeps its
     * tombstone undeleted, so a register naming it is refused until a later pass removes it.
     */
    readonly finishDeletion: (token: string, deleted: ReadonlyArray<string>) => Effect.Effect<void>;
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

const ReferenceStateRow = Schema.Struct({
  guards: Schema.Record(Schema.String, Schema.Union([Schema.Number, Schema.String])),
  tombstones: Schema.Array(Schema.Struct({ key: Schema.String, deleted: Schema.Boolean })),
});

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
      launchId?: string,
    ) {
      const launch = launchId ?? null;
      // A concurrent claimer re-evaluates WHERE after the row lock; the chain learns the new
      // epoch in the same statement, so a stale register cannot land between this claim and
      // the new executor's first register.
      const rows = yield* sql<{ readonly epoch: number }>`
        WITH l AS (
          UPDATE worktree_leases
             SET executor_id = ${executorId},
                 launch_id = ${launch}::text,
                 epoch = epoch + 1,
                 expires_at = now() + make_interval(secs => ${ttlSeconds})
           WHERE worktree_id = ${worktreeId}
             AND (expires_at IS NULL OR expires_at < now())
             AND (executor_id IS NULL
                  OR (executor_id = ${executorId}
                      AND (launch_id IS NULL
                           OR ${launch}::text IS NULL
                           OR launch_id = ${launch}::text))
                  OR executor_id LIKE 'mend:%')
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
      holder?: LeaseHolder,
    ) {
      const rows = yield* sql<{ readonly worktreeId: string }>`
        UPDATE worktree_leases
           SET expires_at = now() + make_interval(secs => ${ttlSeconds})
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch} AND executor_id IS NOT NULL
           AND (${holder === undefined}::boolean
                OR (executor_id = ${holder?.executorId ?? ""}
                    AND (launch_id IS NULL OR launch_id = ${holder?.launchId ?? ""})))
         RETURNING worktree_id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const register = Effect.fn("CaptureStoreRepo.register")(function* (capture: RegisterCapture) {
      // The CAS joins the live lease row; the captures row exists only if the CAS matched.
      // `head_capture IS NOT DISTINCT FROM $parent` is the wrong-parent check (NULL for n = 0).
      // Every chain whose objects the capture names must still hold the guard the register read
      // before it looked in the bucket (each UPDATE re-reads its row after a concurrent writer's
      // lock, so a retention pass that condemned anything in between makes this one miss), and
      // each is bumped, so a retention pass that read before this lands misses instead.
      const guards = capture.guards ?? [];
      const ownGuard = guards.find((entry) => entry.worktreeId === capture.worktreeId);
      const foreign = guards.filter((entry) => entry.worktreeId !== capture.worktreeId);
      // A condemned key never comes back (cross-repo decision 6): a pass that stalled past its
      // claim may still delete it after this lands.
      const names = JSON.stringify(capture.names ?? []);
      const sealExecutor = capture.seal?.executorId ?? "";
      const sealHolder = capture.seal?.holder ?? "";
      const sealBoot = capture.seal?.bootId ?? null;
      const sealGeneration = capture.seal?.bootGeneration ?? null;
      const sealObservation = capture.seal?.observation ?? null;
      // The launch registering (cross-repo decision 11): an older launch of the holder never
      // lands under a newer launch's epoch, whatever it learnt of it.
      const holderGiven = capture.holder !== undefined;
      const holderExecutor = capture.holder?.executorId ?? "";
      const holderLaunch = capture.holder?.launchId ?? "";
      // One transaction, lease row first (review 2026-09-28 (5) #8). A register that waits on
      // another chain's row must not land after its lease changed hands: holding the lease row
      // (FOR SHARE, the order claim and release take — lease, then chain) makes a release or a
      // claim wait for this register, and the statement after it reads the lease as it is now.
      // The chain CAS also requires `head_epoch` to be this capture's epoch — claim moves it in
      // the same statement as the lease — so an older epoch never lands over a newer claim.
      const rows = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              SELECT 1 FROM worktree_leases WHERE worktree_id = ${capture.worktreeId} FOR SHARE`;
            return yield* sql<{ readonly id: string }>`
        WITH expected AS (
          SELECT e.worktree_id, e.guard
            FROM jsonb_to_recordset(${JSON.stringify(
              foreign.map((entry) => ({ worktree_id: entry.worktreeId, guard: entry.guard })),
            )}::jsonb) AS e(worktree_id text, guard bigint)
        ),
        foreign_guards AS (
          UPDATE worktree_chain c
             SET guard = c.guard + 1
            FROM expected e
           WHERE c.worktree_id = e.worktree_id AND c.guard = e.guard
           RETURNING c.worktree_id
        ),
        ch AS (
          UPDATE worktree_chain
             SET head_n = ${capture.n}, head_capture = ${capture.id}, head_epoch = ${capture.epoch},
                 guard = guard + 1
           WHERE worktree_id = ${capture.worktreeId}
             AND head_n = ${capture.n} - 1
             AND head_capture IS NOT DISTINCT FROM ${capture.parent}
             AND head_epoch = ${capture.epoch}
             AND (${ownGuard === undefined}::boolean OR guard = ${ownGuard?.guard ?? 0})
             AND (SELECT count(*) FROM foreign_guards) = ${foreign.length}
             AND NOT EXISTS (
               SELECT 1 FROM capture_tombstones t
                WHERE t.key IN (SELECT jsonb_array_elements_text(${names}::jsonb)))
             AND ${capture.epoch} = (
               SELECT epoch FROM worktree_leases
                WHERE worktree_id = ${capture.worktreeId} AND expires_at > now()
                  AND (NOT ${holderGiven}::boolean
                       OR (executor_id = ${holderExecutor}
                           AND (launch_id IS NULL OR launch_id = ${holderLaunch}))))
           RETURNING worktree_id
        ),
        sealed AS (
          INSERT INTO capture_seals (worktree_id, epoch, executor_id, capture_id, n, boot_id,
                                     boot_generation, observation)
          SELECT ${capture.worktreeId}, ${capture.epoch}, ${sealExecutor}, ${capture.id}, ${capture.n},
                 ${sealBoot}::text, ${sealGeneration}::bigint, ${sealObservation}::bigint
            FROM ch
           WHERE ${capture.seal !== undefined}::boolean
             AND EXISTS (
               SELECT 1 FROM worktree_leases
                WHERE worktree_id = ${capture.worktreeId}
                  AND executor_id = ${sealHolder}
                  AND (launch_id IS NULL OR launch_id = ${sealExecutor}))
          ON CONFLICT (worktree_id, epoch) DO UPDATE
             SET executor_id = EXCLUDED.executor_id, capture_id = EXCLUDED.capture_id,
                 n = EXCLUDED.n, sealed_at = now(), boot_id = EXCLUDED.boot_id,
                 boot_generation = EXCLUDED.boot_generation, observation = EXCLUDED.observation,
                 reverified_at = NULL, void_reason = NULL
           WHERE capture_seals.n < EXCLUDED.n
          RETURNING worktree_id
        )
        INSERT INTO captures (id, worktree_id, n, parent, epoch, seq, kind, manifest_key,
                              sections, git_fsck)
        SELECT ${capture.id}, ${capture.worktreeId}, ${capture.n}, ${capture.parent},
               ${capture.epoch}, ${capture.seq.toString()}::bigint, ${capture.kind},
               ${capture.manifestKey}, ${JSON.stringify(capture.sections)}::jsonb,
               ${capture.gitFsck}
          FROM ch
        RETURNING id`;
          }),
        )
        .pipe(Effect.orDie);
      if (rows.length > 0) return { lostAck: false };
      // Zero rows: diagnose. Same n, same id = a retry after a lost ack.
      const [existing] = yield* sql<{
        readonly id: string;
        readonly headN: number;
        readonly headCapture: string | null;
        readonly leaseEpoch: number | null;
      }>`
        SELECT c.id,
               ch.head_n,
               ch.head_capture,
               (SELECT epoch::int FROM worktree_leases
                 WHERE worktree_id = ${capture.worktreeId} AND expires_at > now()
                   AND (NOT ${holderGiven}::boolean
                        OR (executor_id = ${holderExecutor}
                            AND (launch_id IS NULL OR launch_id = ${holderLaunch})))) AS lease_epoch
          FROM worktree_chain ch
          LEFT JOIN captures c
            ON c.worktree_id = ch.worktree_id AND c.n = ${capture.n}
         WHERE ch.worktree_id = ${capture.worktreeId}`.pipe(Effect.orDie);
      if (existing !== undefined && existing.id === capture.id) return { lostAck: true };
      const reason: CaptureConflictReason =
        existing === undefined || existing.leaseEpoch === null
          ? "stale_epoch"
          : Number(existing.leaseEpoch) !== capture.epoch
            ? "stale_epoch"
            : Number(existing.headN) !== capture.n - 1
              ? "head_moved"
              : existing.headCapture !== capture.parent
                ? "wrong_parent"
                : "guard_moved";
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
      const rows = yield* sql<{ readonly worktreeId: string }>`
        UPDATE worktree_leases
           SET expires_at = now(), executor_id = NULL, launch_id = NULL
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch}
         RETURNING worktree_id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const acceptSummary = Effect.fn("CaptureStoreRepo.acceptSummary")(function* (
      worktreeId: WorktreeId,
      captureId: string,
      key: string,
    ) {
      const rows = yield* sql<{ readonly captureId: string }>`
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
      const rows = yield* sql<{ readonly captureId: string }>`
        UPDATE capture_summaries SET state = ${state}, updated_at = now()
         WHERE capture_id = ${captureId}
         RETURNING capture_id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const setGitFsck = Effect.fn("CaptureStoreRepo.setGitFsck")(function* (
      captureId: string,
      outcome: CaptureGitFsck,
    ) {
      const rows = yield* sql<{ readonly id: string }>`
        UPDATE captures SET git_fsck = ${outcome}
         WHERE id = ${captureId}
         RETURNING id`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    // Raw `sql` reads name their result keys in camelCase: the client transforms every result name
    // with snakeToCamel (`client.ts`), so `executor_id` arrives as `executorId` — a snake_case key
    // here reads `undefined` and silently turns a held lease into a free one (observed in the e2e).
    const leaseOf = Effect.fn("CaptureStoreRepo.leaseOf")(function* (worktreeId: WorktreeId) {
      const [row] = yield* sql<{
        readonly worktreeId: WorktreeId;
        readonly executorId: string | null;
        readonly launchId: string | null;
        readonly epoch: number;
        readonly expiresAt: Date | null;
        readonly live: boolean;
      }>`
        SELECT worktree_id, executor_id, launch_id, epoch::int AS epoch, expires_at,
               (expires_at IS NOT NULL AND expires_at > now()) AS live
          FROM worktree_leases WHERE worktree_id = ${worktreeId}`.pipe(Effect.orDie);
      return row === undefined
        ? null
        : {
            worktreeId: row.worktreeId,
            executorId: row.executorId,
            launchId: row.launchId,
            epoch: Number(row.epoch),
            expiresAt: row.expiresAt,
            live: row.live,
          };
    });

    const headOf = Effect.fn("CaptureStoreRepo.headOf")(function* (worktreeId: WorktreeId) {
      const [chain] = yield* sql<{
        readonly worktreeId: WorktreeId;
        readonly headCapture: string | null;
        readonly headN: number;
        readonly headEpoch: number;
      }>`
        SELECT worktree_id, head_capture, head_n, head_epoch::int AS head_epoch
          FROM worktree_chain WHERE worktree_id = ${worktreeId}`.pipe(Effect.orDie);
      if (chain === undefined) return null;
      const head = chain.headCapture === null ? null : yield* captureById(chain.headCapture);
      return {
        worktreeId: chain.worktreeId,
        headN: Number(chain.headN),
        headEpoch: Number(chain.headEpoch),
        head,
      };
    });

    const sealedCompletion = Effect.fn("CaptureStoreRepo.sealedCompletion")(function* (
      worktreeId: WorktreeId,
      executorId: string,
      epoch?: number,
    ) {
      const [row] = yield* sql<{
        readonly worktreeId: WorktreeId;
        readonly epoch: number;
        readonly executorId: string;
        readonly captureId: string;
        readonly n: number;
        readonly sealedAt: Date;
        readonly bootId: string | null;
        readonly bootGeneration: string | number | null;
        readonly observation: string | number | null;
        readonly reverifiedAt: Date | null;
        readonly voidReason: string | null;
      }>`
        SELECT worktree_id, epoch::int AS epoch, executor_id, capture_id, n, sealed_at, boot_id,
               boot_generation, observation, reverified_at, void_reason
          FROM capture_seals
         WHERE worktree_id = ${worktreeId}
           AND executor_id = ${executorId}
           AND (${epoch === undefined}::boolean OR epoch = ${epoch ?? 0})
         ORDER BY epoch DESC
         LIMIT 1`.pipe(Effect.orDie);
      return row === undefined
        ? null
        : {
            worktreeId: row.worktreeId,
            epoch: Number(row.epoch),
            executorId: row.executorId,
            captureId: row.captureId,
            n: Number(row.n),
            sealedAt: row.sealedAt,
            bootId: row.bootId,
            bootGeneration: row.bootGeneration === null ? null : Number(row.bootGeneration),
            observation: row.observation === null ? null : Number(row.observation),
            reverifiedAt: row.reverifiedAt,
            voidReason: row.voidReason,
          };
    });

    const recordPutAuthority = Effect.fn("CaptureStoreRepo.recordPutAuthority")(function* (
      worktreeId: WorktreeId,
      epoch: number,
      expiresAt: Date,
    ) {
      yield* sql`
        INSERT INTO capture_put_authority (worktree_id, epoch, expires_at)
        VALUES (${worktreeId}, ${epoch}, ${expiresAt})
        ON CONFLICT (worktree_id, epoch) DO UPDATE
           SET expires_at = GREATEST(capture_put_authority.expires_at, EXCLUDED.expires_at)`.pipe(
        Effect.orDie,
      );
    });

    const putAuthorityUntil = Effect.fn("CaptureStoreRepo.putAuthorityUntil")(function* (
      worktreeId: WorktreeId,
      epoch: number,
    ) {
      const [row] = yield* sql<{ readonly expiresAt: Date }>`
        SELECT expires_at FROM capture_put_authority
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch}`.pipe(Effect.orDie);
      return row?.expiresAt ?? null;
    });

    const markSealReverified = Effect.fn("CaptureStoreRepo.markSealReverified")(function* (
      worktreeId: WorktreeId,
      epoch: number,
      captureId: string,
      at: Date,
    ) {
      yield* sql`
        UPDATE capture_seals
           SET reverified_at = GREATEST(COALESCE(reverified_at, ${at}), ${at})
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch} AND capture_id = ${captureId}
           AND void_reason IS NULL`.pipe(Effect.orDie);
    });

    const voidSeal = Effect.fn("CaptureStoreRepo.voidSeal")(function* (
      worktreeId: WorktreeId,
      epoch: number,
      captureId: string,
      reason: string,
    ) {
      yield* sql`
        UPDATE capture_seals SET void_reason = COALESCE(void_reason, ${reason})
         WHERE worktree_id = ${worktreeId} AND epoch = ${epoch}
           AND capture_id = ${captureId}`.pipe(Effect.orDie);
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
      // One row per digest: an upsert may not touch the same row twice in one statement.
      const byDigest = new Map<string, PackRecord>();
      for (const record of records) {
        if (!byDigest.has(digestOf(record.key))) byDigest.set(digestOf(record.key), record);
      }
      const unique = [...byDigest.values()];
      if (unique.length === 0) return;
      yield* db
        .insert(packs)
        .values(
          unique.map((record) => ({
            id: digestOf(record.key),
            key: record.key,
            class: record.class,
            bytes: record.bytes,
            worktreeId: record.worktreeId,
            epoch: record.epoch,
            platform: record.platform,
          })),
        )
        // A retired pack (its key condemned for good) whose content a register names again under
        // a new key — a new generation or epoch — is live again at that key, so a later pass
        // weighs and retires it there.
        .onConflictDoUpdate({
          target: packs.id,
          set: { state: "uploaded", key: drizzleSql`excluded.key`, updatedAt: new Date() },
          setWhere: eq(packs.state, "retired"),
        })
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
          guard: worktreeChain.guard,
        })
        .from(worktreeChain)
        .pipe(Effect.orDie);
      return rows.map((row) => ({
        worktreeId: row.worktreeId,
        headCapture: row.headCapture,
        headN: Number(row.headN),
        guard: Number(row.guard),
      }));
    });

    const referenceState = Effect.fn("CaptureStoreRepo.referenceState")(function* (
      worktreeIds: ReadonlyArray<WorktreeId>,
      keys: ReadonlyArray<string>,
    ) {
      // One statement, so the guards and the tombstones come from one snapshot: a tombstone
      // written after it was taken bumped a guard this read returns stale.
      const [row] = yield* sql<{ readonly guards: unknown; readonly tombstones: unknown }>`
        SELECT
          (SELECT coalesce(jsonb_object_agg(worktree_id, guard), '{}'::jsonb)
             FROM worktree_chain
            WHERE worktree_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(worktreeIds)}::jsonb)))
            AS guards,
          (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'key', t.key,
                     'deleted', t.deleted_at IS NOT NULL AND NOT EXISTS (
                       SELECT 1 FROM capture_deletion_claims d
                        WHERE d.key = t.key AND d.expires_at > now()))),
                   '[]'::jsonb)
             FROM capture_tombstones t
            WHERE t.key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)))
            AS tombstones`.pipe(Effect.orDie);
      const decoded = Schema.decodeUnknownSync(ReferenceStateRow)(row ?? {});
      const guards = new Map<WorktreeId, number>();
      for (const worktreeId of worktreeIds) {
        const guard = decoded.guards[worktreeId];
        if (guard !== undefined) guards.set(worktreeId, Number(guard));
      }
      return { guards, tombstones: decoded.tombstones };
    });

    const condemn = Effect.fn("CaptureStoreRepo.condemn")(function* (
      worktreeId: WorktreeId,
      guard: number,
      keys: ReadonlyArray<string>,
      hold: DeletionClaim,
    ) {
      if (keys.length === 0) return true;
      // A tombstone already there (a pass that condemned it and failed to delete, one whose
      // bytes came back, or one another pass still holds) is condemned again: its bytes may be
      // going now. The claim rows land in the same statement, only if the guard held.
      const rows = yield* sql<{ readonly worktreeId: string }>`
        WITH ch AS (
          UPDATE worktree_chain SET guard = guard + 1
           WHERE worktree_id = ${worktreeId} AND guard = ${guard}
           RETURNING worktree_id
        ),
        t AS (
          INSERT INTO capture_tombstones (key, worktree_id)
          SELECT k.key, ch.worktree_id
            FROM ch, jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb) AS k(key)
          ON CONFLICT (key) DO UPDATE SET deleted_at = NULL, created_at = now()
          RETURNING key
        ),
        c AS (
          INSERT INTO capture_deletion_claims (key, token, expires_at)
          SELECT t.key, ${hold.token}, now() + make_interval(secs => ${hold.ttlSeconds})
            FROM t
          ON CONFLICT (key, token) DO NOTHING
          RETURNING key
        )
        SELECT worktree_id FROM ch`.pipe(Effect.orDie);
      return rows.length > 0;
    });

    const renewDeletion = Effect.fn("CaptureStoreRepo.renewDeletion")(function* (
      token: string,
      ttlSeconds: number,
    ) {
      const rows = yield* sql<{ readonly key: string }>`
        UPDATE capture_deletion_claims
           SET expires_at = now() + make_interval(secs => ${ttlSeconds})
         WHERE token = ${token}
           AND NOT EXISTS (
             SELECT 1 FROM capture_deletion_claims
              WHERE token = ${token} AND expires_at <= now())
         RETURNING key`.pipe(Effect.orDie);
      return rows.length;
    });

    const finishDeletion = Effect.fn("CaptureStoreRepo.finishDeletion")(function* (
      token: string,
      deleted: ReadonlyArray<string>,
    ) {
      yield* sql`
        WITH settled AS (
          UPDATE capture_tombstones SET deleted_at = now()
           WHERE key IN (SELECT jsonb_array_elements_text(${JSON.stringify(deleted)}::jsonb))
             AND deleted_at IS NULL
           RETURNING key
        )
        DELETE FROM capture_deletion_claims WHERE token = ${token}`.pipe(Effect.orDie);
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
      setGitFsck,
      leaseOf,
      headOf,
      sealedCompletion,
      recordPutAuthority,
      putAuthorityUntil,
      markSealReverified,
      voidSeal,
      listChain,
      captureById,
      recordPacks,
      summaryOf,
      listChains,
      referenceState,
      condemn,
      renewDeletion,
      finishDeletion,
      deleteCaptures,
      listPacks,
      setPackState,
    };
  }),
);
