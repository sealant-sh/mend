import { CaptureStoreRepo } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import { BlobStore, storedCaptureProblem } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * The store's sealed record of a completed final flush (cross-repo decision 1, 2026-09-28): when
 * sealantd's final flush completes — every writer stopped, both classes snapshotted and shipped —
 * it registers a sealing capture whose manifest carries `final_seal: { complete: true, epoch,
 * executor }`, and the register records it on the chain, per worktree and epoch. With a
 * `complete: true` Mend itself observed from that exact executor and epoch, it is the only
 * evidence that an executor's work is saved; a final-kind capture without it is not.
 */
export interface CaptureCompletionSeal {
  readonly worktreeId: WorktreeId;
  readonly epoch: number;
  /** The executor the seal was recorded for: the session its channel token was issued for. */
  readonly executorId: string;
  readonly captureId: string;
  readonly n: number;
  /** When the store recorded it, by the database's clock: display only (cross-repo decision 17). */
  readonly sealedAt: Date;
  /** Where sealantd stamped the seal in its own order; null or absent when it did not. */
  readonly bootId?: string | null;
  readonly bootGeneration?: number | null;
  readonly observation?: number | null;
}

/**
 * Read the sealed record for one worktree, executor and epoch (the newest when the epoch is
 * omitted) — the same signature as `CaptureStoreRepo.sealedCompletion`, which records a seal only
 * for `final_seal.complete === true`, under the matching epoch, for the executor the session token
 * was issued for. The engine also checks that nothing registered after the sealing capture under
 * that epoch (a capture staged after it — a turn boundary — unseals the chain until the next
 * final flush seals it again).
 *
 * The API provides it from `CaptureStoreRepo.sealedCompletion` (migration 0080) beside the capture
 * runtime (`apps/api/src/main.ts`), as it stands over what the bucket can still replace
 * (`CaptureSealsStoreLive`). Where nothing provides it — the co-located store, tests —
 * the engine reads `CaptureSealsNone`: no seal is ever found, so nothing reads saved on a seal
 * and every drain still needs the executor's own `complete: true`. Never the other way round.
 */
export class CaptureSeals extends Context.Service<
  CaptureSeals,
  {
    readonly sealedCompletion: (
      worktreeId: WorktreeId,
      executorId: string,
      epoch?: number,
    ) => Effect.Effect<CaptureCompletionSeal | null>;
  }
>()("@mend/sessions/CaptureSeals") {}

/** No seal is recorded anywhere: what the engine reads when nothing provides the store's. */
export const CaptureSealsNone: Layer.Layer<CaptureSeals> = Layer.succeed(CaptureSeals, {
  sealedCompletion: () => Effect.succeed(null),
});

/**
 * The store's seals as they stand (review 2026-09-28 (7) #8): a seal recorded at register rests on
 * bytes Mend read then. On a bucket that refuses to replace an object (`BlobStore.replaceableUntil`
 * answers 0: S3, R2, MinIO, the directory store) they stay those bytes, and the seal stands as
 * recorded. On one that does not (Garage ignores `If-None-Match`), an upload URL handed out under
 * the seal's epoch could replace an object until it expires — the latest such expiry is recorded
 * before any URL is handed out (`CaptureStoreRepo.putAuthorityUntil`), and the store adds what
 * this process minted and a URL minted before it started could still do. So:
 * - while any such URL could still be used, the seal does not stand (null): completion withheld;
 * - once none can, every object the sealed capture names is read back (`storedCaptureProblem`):
 *   all what their names say → the seal stands, and is marked re-verified from that moment until
 *   another URL is handed out under its epoch; any other bytes → the seal is void, for good;
 * - a store that could not be read concludes nothing: withheld, asked again on the next read.
 */
export const makeCaptureSealsStore = (options?: {
  readonly now?: () => number;
}): Layer.Layer<CaptureSeals, never, CaptureStoreRepo | BlobStore> =>
  Layer.effect(
    CaptureSeals,
    Effect.gen(function* () {
      const repo = yield* CaptureStoreRepo;
      const blobs = yield* BlobStore;
      const now = options?.now ?? Date.now;
      const sealedCompletion = Effect.fn("CaptureSeals.sealedCompletion")(function* (
        worktreeId: WorktreeId,
        executorId: string,
        epoch?: number,
      ) {
        const seal = yield* repo.sealedCompletion(worktreeId, executorId, epoch);
        if (seal === null) return null;
        const annotations = {
          worktreeId,
          epoch: seal.epoch,
          n: seal.n,
          captureId: seal.captureId,
        };
        if ((seal.voidReason ?? null) !== null) return null;
        const row = yield* repo.captureById(seal.captureId);
        if (row === null) return null;
        const storeUntil = yield* blobs.replaceableUntil(row.manifestKey);
        if (storeUntil === 0) return seal;
        const recorded = yield* repo.putAuthorityUntil(worktreeId, seal.epoch);
        const until = Math.max(storeUntil, recorded?.getTime() ?? 0);
        const at = now();
        if (at < until) {
          yield* Effect.logInfo(
            "capture seals: sealed, but an upload URL of its epoch could still replace what it names · withheld until it expires",
          ).pipe(
            Effect.annotateLogs({
              ...annotations,
              replaceableUntil: new Date(until).toISOString(),
            }),
          );
          return null;
        }
        const reverified = seal.reverifiedAt?.getTime() ?? null;
        if (reverified !== null && reverified >= until) return seal;
        const problem = yield* storedCaptureProblem(row.manifestKey).pipe(
          Effect.provideService(BlobStore, blobs),
          Effect.result,
        );
        if (problem._tag === "Failure") {
          yield* Effect.logWarning(
            "capture seals: sealed, but its objects could not be read back · withheld",
          ).pipe(Effect.annotateLogs({ ...annotations, error: problem.failure.message }));
          return null;
        }
        if (problem.success !== null) {
          yield* repo.voidSeal(worktreeId, seal.epoch, seal.captureId, problem.success);
          yield* Effect.logError(
            "capture seals: an object the seal names read back as other bytes · the seal is void",
          ).pipe(Effect.annotateLogs({ ...annotations, problem: problem.success }));
          return null;
        }
        yield* repo.markSealReverified(worktreeId, seal.epoch, seal.captureId, new Date(at));
        return seal;
      });
      return { sealedCompletion };
    }),
  );

/** `makeCaptureSealsStore` on the wall clock: what the API provides beside the capture store. */
export const CaptureSealsStoreLive: Layer.Layer<CaptureSeals, never, CaptureStoreRepo | BlobStore> =
  makeCaptureSealsStore();
