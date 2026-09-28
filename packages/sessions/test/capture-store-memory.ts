import {
  CaptureConflictError,
  CaptureStoreRepo,
  type CaptureRow,
  type PackRow,
  type RegisterCapture,
  type WorktreeLease,
  SummaryRejectedError,
  WorktreeLeasedError,
  type CaptureSummaryRow,
  type PackState,
  type SealedCompletion,
  captureScopesOf,
} from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import { Effect, Layer } from "effect";

/**
 * `CaptureStoreRepo` in memory with the SQL's semantics (`repos/capture-store.ts`): the claim
 * predicate, the register CAS joined to the live lease, the lost-ack rule, summaries only for
 * the head. `now` is injectable so a test can expire a lease without waiting.
 */
export interface MemoryCaptureStore {
  readonly layer: Layer.Layer<CaptureStoreRepo>;
  readonly clock: { now: () => number };
  readonly leases: Map<string, MemoryLease>;
  readonly chains: Map<string, MemoryChain>;
  readonly captures: Map<string, CaptureRow>;
  /** `capture_tombstones`: key → owning worktree and whether the bytes are gone. */
  readonly tombstones: Map<string, { worktreeId: string; deleted: boolean }>;
  /** `capture_seals`: `<worktree>:<epoch>` → the sealed completion. */
  readonly seals: Map<string, SealedCompletion>;
  /** `capture_put_authority`: `<worktree>:<epoch>` → the latest upload URL expiry (0089). */
  readonly putAuthority: Map<string, Date>;
  /** `capture_deletion_claims`: key → token → when the claim lapses (store clock, ms). */
  readonly claims: Map<string, Map<string, number>>;
  readonly packs: Map<string, PackRow>;
  readonly summaries: Map<string, CaptureSummaryRow>;
}

/** A lease row; `launchId` absent reads null (a lease bound to no launch). */
export interface MemoryLease {
  executorId: string | null;
  epoch: number;
  expiresAt: number | null;
  launchId?: string | null;
}

/** A chain row; `guard` absent reads 0 (tests that build chains by hand leave it out). */
export interface MemoryChain {
  headCapture: string | null;
  headN: number;
  headEpoch: number;
  guard?: number;
}

const digestOf = (key: string) => key.slice(key.lastIndexOf("/") + 1).replace(/\.idx$/, "");

/** The lease names `holder` and its launch (or no launch); anyone, when no holder is given. */
const holdsAs = (
  lease: MemoryLease,
  holder: { readonly executorId: string; readonly launchId: string } | undefined,
) =>
  holder === undefined ||
  (lease.executorId === holder.executorId &&
    ((lease.launchId ?? null) === null || lease.launchId === holder.launchId));

export const makeMemoryCaptureStore = (): MemoryCaptureStore => {
  const clock = { now: () => Date.now() };
  const leases = new Map<string, MemoryLease>();
  const chains = new Map<string, MemoryChain>();
  const tombstones = new Map<string, { worktreeId: string; deleted: boolean }>();
  const claims = new Map<string, Map<string, number>>();
  const seals = new Map<string, SealedCompletion>();
  /** `capture_put_authority`: `<worktree>:<epoch>` → the latest upload URL expiry. */
  const putAuthority = new Map<string, Date>();
  /** A live deletion claim on `key`: some pass may still delete its bytes. */
  const claimed = (key: string) =>
    [...(claims.get(key)?.values() ?? [])].some((expiresAt) => expiresAt > clock.now());
  /** A condemned key a register may bring back: its bytes gone, no pass still holding it. */
  const revivable = (key: string) => tombstones.get(key)?.deleted === true && !claimed(key);
  const captures = new Map<string, CaptureRow>();
  const packs = new Map<string, PackRow>();
  const summaries = new Map<string, CaptureSummaryRow>();
  const live = (lease: { expiresAt: number | null }) =>
    lease.expiresAt !== null && lease.expiresAt > clock.now();
  const leaseView = (worktreeId: WorktreeId): WorktreeLease | null => {
    const lease = leases.get(worktreeId);
    return lease === undefined
      ? null
      : {
          worktreeId,
          executorId: lease.executorId,
          launchId: lease.launchId ?? null,
          epoch: lease.epoch,
          expiresAt: lease.expiresAt === null ? null : new Date(lease.expiresAt),
          live: live(lease),
        };
  };
  const layer = Layer.succeed(CaptureStoreRepo, {
    init: (worktreeId) =>
      Effect.sync(() => {
        if (!leases.has(worktreeId)) {
          leases.set(worktreeId, { executorId: null, epoch: 0, expiresAt: null });
        }
        if (!chains.has(worktreeId)) {
          chains.set(worktreeId, { headCapture: null, headN: -1, headEpoch: 0, guard: 0 });
        }
      }),
    claim: (worktreeId, executorId, ttlSeconds = 30, launchId) =>
      Effect.suspend(() => {
        const lease = leases.get(worktreeId);
        const chain = chains.get(worktreeId);
        if (lease === undefined || chain === undefined || live(lease)) {
          return Effect.fail(new WorktreeLeasedError({ worktreeId }));
        }
        // A lapsed lease of another executor is not an end: only a release clears the holder.
        if (
          lease.executorId !== null &&
          lease.executorId !== executorId &&
          !lease.executorId.startsWith("mend:")
        ) {
          return Effect.fail(new WorktreeLeasedError({ worktreeId }));
        }
        // The same holder under another launch is another executor (cross-repo decision 11).
        const bound = lease.launchId ?? null;
        if (
          lease.executorId === executorId &&
          bound !== null &&
          launchId !== undefined &&
          bound !== launchId
        ) {
          return Effect.fail(new WorktreeLeasedError({ worktreeId }));
        }
        lease.executorId = executorId;
        lease.launchId = launchId ?? null;
        lease.epoch += 1;
        lease.expiresAt = clock.now() + ttlSeconds * 1000;
        chain.headEpoch = lease.epoch;
        return Effect.succeed({ epoch: lease.epoch });
      }),
    heartbeat: (worktreeId, epoch, ttlSeconds = 30, holder) =>
      Effect.sync(() => {
        const lease = leases.get(worktreeId);
        if (lease === undefined || lease.epoch !== epoch || lease.executorId === null) return false;
        if (!holdsAs(lease, holder)) return false;
        lease.expiresAt = clock.now() + ttlSeconds * 1000;
        return true;
      }),
    register: (capture: RegisterCapture) =>
      Effect.suspend((): Effect.Effect<{ readonly lostAck: boolean }, CaptureConflictError> => {
        const chain = chains.get(capture.worktreeId);
        const lease = leases.get(capture.worktreeId);
        const leaseEpoch =
          lease !== undefined && live(lease) && holdsAs(lease, capture.holder) ? lease.epoch : null;
        const guards = capture.guards ?? [];
        const guardsHold = guards.every(
          (entry) => (chains.get(entry.worktreeId)?.guard ?? Number.NaN) === entry.guard,
        );
        // The SQL bumps the foreign guards that still hold even when the CAS misses.
        for (const entry of guards) {
          const other = chains.get(entry.worktreeId);
          if (entry.worktreeId !== capture.worktreeId && other !== undefined) {
            if ((other.guard ?? 0) === entry.guard) other.guard = entry.guard + 1;
          }
        }
        if (
          chain !== undefined &&
          chain.headN === capture.n - 1 &&
          chain.headCapture === capture.parent &&
          leaseEpoch === capture.epoch &&
          guardsHold &&
          (capture.names ?? []).every((key) => !tombstones.has(key))
        ) {
          chain.headN = capture.n;
          chain.headCapture = capture.id;
          chain.headEpoch = capture.epoch;
          chain.guard = (chain.guard ?? 0) + 1;
          const sealKey = `${capture.worktreeId}:${capture.epoch}`;
          const sealed = seals.get(sealKey);
          if (
            capture.seal !== undefined &&
            lease?.executorId === capture.seal.holder &&
            ((lease.launchId ?? null) === null || lease.launchId === capture.seal.executorId) &&
            (sealed === undefined || sealed.n < capture.n)
          ) {
            seals.set(sealKey, {
              worktreeId: capture.worktreeId,
              epoch: capture.epoch,
              executorId: capture.seal.executorId,
              captureId: capture.id,
              n: capture.n,
              sealedAt: new Date(clock.now()),
              bootId: capture.seal.bootId ?? null,
              bootGeneration: capture.seal.bootGeneration ?? null,
              observation: capture.seal.observation ?? null,
              scopes: captureScopesOf({ worktreeId: capture.worktreeId, epoch: capture.epoch }, [
                capture.manifestKey,
                ...(capture.names ?? []),
                ...(capture.seal.scopes ?? []).map(
                  (scope) => `captures/${scope.worktreeId}/${scope.epoch}/`,
                ),
              ]),
            });
          }
          captures.set(capture.id, {
            id: capture.id,
            worktreeId: capture.worktreeId,
            n: capture.n,
            parent: capture.parent,
            epoch: capture.epoch,
            seq: capture.seq,
            kind: capture.kind,
            manifestKey: capture.manifestKey,
            sections: capture.sections,
            gitFsck: capture.gitFsck,
            createdAt: new Date(clock.now()),
          });
          return Effect.succeed({ lostAck: false });
        }
        const existing = [...captures.values()].find(
          (row) => row.worktreeId === capture.worktreeId && row.n === capture.n,
        );
        if (existing !== undefined && existing.id === capture.id) {
          return Effect.succeed({ lostAck: true });
        }
        const reason =
          leaseEpoch === null || leaseEpoch !== capture.epoch
            ? "stale_epoch"
            : chain === undefined || chain.headN !== capture.n - 1
              ? "head_moved"
              : chain.headCapture !== capture.parent
                ? "wrong_parent"
                : "guard_moved";
        return Effect.fail(
          new CaptureConflictError({ worktreeId: capture.worktreeId, n: capture.n, reason }),
        );
      }),
    release: (worktreeId, epoch) =>
      Effect.sync(() => {
        const lease = leases.get(worktreeId);
        if (lease === undefined || lease.epoch !== epoch) return false;
        lease.expiresAt = clock.now();
        lease.executorId = null;
        lease.launchId = null;
        return true;
      }),
    acceptSummary: (worktreeId, captureId, key) =>
      Effect.suspend(() => {
        const chain = chains.get(worktreeId);
        if (chain === undefined || chain.headCapture !== captureId) {
          return Effect.fail(new SummaryRejectedError({ worktreeId, captureId }));
        }
        summaries.set(captureId, {
          captureId,
          worktreeId,
          key,
          state: "claimed",
          createdAt: new Date(clock.now()),
          updatedAt: new Date(clock.now()),
        });
        return Effect.void;
      }),
    setSummaryState: (captureId, state) =>
      Effect.sync(() => {
        const row = summaries.get(captureId);
        if (row === undefined) return false;
        summaries.set(captureId, { ...row, state, updatedAt: new Date(clock.now()) });
        return true;
      }),
    setGitFsck: (captureId, outcome) =>
      Effect.sync(() => {
        const row = captures.get(captureId);
        if (row === undefined) return false;
        captures.set(captureId, { ...row, gitFsck: outcome });
        return true;
      }),
    leaseOf: (worktreeId) => Effect.sync(() => leaseView(worktreeId)),
    headOf: (worktreeId) =>
      Effect.sync(() => {
        const chain = chains.get(worktreeId);
        if (chain === undefined) return null;
        return {
          worktreeId,
          headN: chain.headN,
          headEpoch: chain.headEpoch,
          head: chain.headCapture === null ? null : (captures.get(chain.headCapture) ?? null),
        };
      }),
    sealedCompletion: (worktreeId, executorId, epoch) =>
      Effect.sync(
        () =>
          [...seals.values()]
            .filter(
              (seal) =>
                seal.worktreeId === worktreeId &&
                seal.executorId === executorId &&
                (epoch === undefined || seal.epoch === epoch),
            )
            .toSorted((a, b) => b.epoch - a.epoch)[0] ?? null,
      ),
    recordPutAuthority: (worktreeId, epoch, expiresAt, checkedSeals, holder) =>
      Effect.sync(() => {
        // The lease as it is now (cross-repo decision 31): live, under `epoch`, the holder's.
        if (holder !== undefined) {
          const lease = leases.get(worktreeId);
          if (
            lease === undefined ||
            lease.epoch !== epoch ||
            !live(lease) ||
            lease.executorId === null ||
            !holdsAs(lease, holder)
          ) {
            return { recorded: false, reason: "lease" } as const;
          }
        }
        const key = `${worktreeId}:${epoch}`;
        // A recorded seal whose objects live under this prefix, any epoch's, that the caller did
        // not check its keys against: nothing recorded (0091, 0092, cross-repo decisions 26, 31).
        const covering = [...seals.values()].filter(
          (seal) =>
            (seal.voidReason ?? null) === null &&
            ((seal.worktreeId === worktreeId && seal.epoch === epoch) ||
              (seal.scopes ?? []).some(
                (scope) => scope.worktreeId === worktreeId && scope.epoch === epoch,
              )),
        );
        const checked = new Set(checkedSeals ?? []);
        if (covering.some((seal) => !checked.has(seal.captureId))) {
          return {
            recorded: false,
            reason: "sealed",
            sealedCaptures: covering.map((seal) => seal.captureId).toSorted(),
          } as const;
        }
        const kept = putAuthority.get(key);
        if (kept === undefined || kept.getTime() < expiresAt.getTime()) {
          putAuthority.set(key, expiresAt);
        }
        return { recorded: true } as const;
      }),
    putAuthorityUntil: (worktreeId, epoch) =>
      Effect.sync(() => putAuthority.get(`${worktreeId}:${epoch}`) ?? null),
    putAuthorityUntilOver: (scopes) =>
      Effect.sync(() => {
        const times = scopes.flatMap((scope) => {
          const until = putAuthority.get(`${scope.worktreeId}:${scope.epoch}`);
          return until === undefined ? [] : [until.getTime()];
        });
        return times.length === 0 ? null : new Date(Math.max(...times));
      }),
    markSealReverified: (worktreeId, epoch, captureId, at) =>
      Effect.sync(() => {
        const key = `${worktreeId}:${epoch}`;
        const seal = seals.get(key);
        if (
          seal === undefined ||
          seal.captureId !== captureId ||
          (seal.voidReason ?? null) !== null
        ) {
          return false;
        }
        // A URL of any epoch its objects live under handed out since `at`: the read-back is
        // void (review 2026-09-28 (8) #5, (10) #5).
        const scopes = seal.scopes ?? [{ worktreeId, epoch }];
        if (
          scopes.some(
            (scope) =>
              (putAuthority.get(`${scope.worktreeId}:${scope.epoch}`)?.getTime() ?? 0) >
              at.getTime(),
          )
        ) {
          return false;
        }
        const kept = seal.reverifiedAt ?? null;
        seals.set(key, {
          ...seal,
          reverifiedAt: kept === null || kept.getTime() < at.getTime() ? at : kept,
        });
        return true;
      }),
    voidSeal: (worktreeId, epoch, captureId, reason) =>
      Effect.sync(() => {
        const key = `${worktreeId}:${epoch}`;
        const seal = seals.get(key);
        if (seal === undefined || seal.captureId !== captureId) return;
        seals.set(key, { ...seal, voidReason: seal.voidReason ?? reason });
      }),
    listChain: (worktreeId) =>
      Effect.sync(() =>
        [...captures.values()]
          .filter((row) => row.worktreeId === worktreeId)
          .toSorted((a, b) => a.n - b.n),
      ),
    captureById: (captureId) => Effect.sync(() => captures.get(captureId) ?? null),
    recordPacks: (records) =>
      Effect.sync(() => {
        for (const record of records) {
          const id = digestOf(record.key);
          const known = packs.get(id);
          if (known?.state === "retired") {
            packs.set(id, {
              ...known,
              key: record.key,
              state: "uploaded",
              updatedAt: new Date(clock.now()),
            });
          }
          if (known !== undefined) continue;
          packs.set(id, {
            id,
            key: record.key,
            class: record.class,
            state: "uploaded",
            bytes: record.bytes,
            worktreeId: record.worktreeId,
            epoch: record.epoch,
            platform: record.platform,
            createdAt: new Date(clock.now()),
            updatedAt: new Date(clock.now()),
          });
        }
      }),
    summaryOf: (captureId) => Effect.sync(() => summaries.get(captureId) ?? null),
    listChains: () =>
      Effect.sync(() =>
        [...chains.entries()].map(([worktreeId, chain]) => ({
          worktreeId: worktreeId as WorktreeId,
          headCapture: chain.headCapture,
          headN: chain.headN,
          guard: chain.guard ?? 0,
        })),
      ),
    referenceState: (worktreeIds, keys) =>
      Effect.sync(() => {
        const guards = new Map<WorktreeId, number>();
        for (const worktreeId of worktreeIds) {
          const chain = chains.get(worktreeId);
          if (chain !== undefined) guards.set(worktreeId, chain.guard ?? 0);
        }
        return {
          guards,
          tombstones: keys.flatMap((key) => {
            const tombstone = tombstones.get(key);
            return tombstone === undefined ? [] : [{ key, deleted: revivable(key) }];
          }),
        };
      }),
    condemn: (worktreeId, guard, keys, claim) =>
      Effect.sync(() => {
        if (keys.length === 0) return true;
        const chain = chains.get(worktreeId);
        if (chain === undefined || (chain.guard ?? 0) !== guard) return false;
        chain.guard = guard + 1;
        for (const key of keys) {
          tombstones.set(key, { worktreeId, deleted: false });
          const held = claims.get(key) ?? new Map<string, number>();
          if (!held.has(claim.token)) held.set(claim.token, clock.now() + claim.ttlSeconds * 1000);
          claims.set(key, held);
        }
        return true;
      }),
    renewDeletion: (token, ttlSeconds) =>
      Effect.sync(() => {
        const held = [...claims.values()].filter((byToken) => byToken.has(token));
        if (held.some((byToken) => (byToken.get(token) ?? 0) <= clock.now())) return 0;
        for (const byToken of held) byToken.set(token, clock.now() + ttlSeconds * 1000);
        return held.length;
      }),
    finishDeletion: (token, deleted) =>
      Effect.sync(() => {
        for (const key of deleted) {
          const tombstone = tombstones.get(key);
          if (tombstone !== undefined) tombstone.deleted = true;
        }
        for (const [key, byToken] of claims) {
          byToken.delete(token);
          if (byToken.size === 0) claims.delete(key);
        }
      }),
    deleteCaptures: (worktreeId, captureIds) =>
      Effect.sync(() => {
        const chain = chains.get(worktreeId);
        let removed = 0;
        for (const id of captureIds) {
          const row = captures.get(id);
          if (row === undefined || row.worktreeId !== worktreeId) continue;
          if (chain?.headCapture === id) continue;
          captures.delete(id);
          summaries.delete(id);
          removed += 1;
        }
        return removed;
      }),
    listPacks: (state?: PackState) =>
      Effect.sync(() =>
        [...packs.values()].filter((row) => state === undefined || row.state === state),
      ),
    setPackState: (packIds, state) =>
      Effect.sync(() => {
        for (const id of packIds) {
          const row = packs.get(id);
          if (row !== undefined) packs.set(id, { ...row, state, updatedAt: new Date(clock.now()) });
        }
      }),
  });

  return {
    layer,
    clock,
    leases,
    chains,
    captures,
    packs,
    summaries,
    tombstones,
    claims,
    seals,
    putAuthority,
  };
};
