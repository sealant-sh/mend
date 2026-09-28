import { type CaptureScopeRef, CaptureStoreRepo, type SealedCompletion } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import { BlobStore, keysOfSections, storedCaptureProblem } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { makeSingleFlight } from "./single-flight.ts";

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
 * How a recorded seal stands right now (review 2026-09-28 (7) #8, (8) #5): what every reader of
 * a seal consults — the engine's attestations (`CaptureSeals`), the register's answer to the
 * executor that sealed (`seal` on `capture.register`), and the plan that would hand the seal on
 * (`final_seal` on `plan.get`).
 * - `standing`: the bytes it names are what they were and nothing handed out can replace them;
 * - `withheld`: recorded, but not standing now — an upload URL of its epoch could still replace
 *   what it names, or the store could not be read back, or a URL was handed out while it was being
 *   read back; asked again, it may stand;
 * - `void`: an object it names read back as other bytes: it never stands again.
 */
export type SealStanding =
  | { readonly state: "standing" }
  | {
      readonly state: "withheld";
      /** `write-authority` (a URL could still replace, or was handed out during the read-back), `verifying`. */
      readonly code: "write-authority" | "verifying";
      readonly reason: string;
    }
  | { readonly state: "void"; readonly code: "void"; readonly reason: string };

/** `epoch 3`, or `epochs 2, 3` — the epochs a seal's objects live under, in its own worktree. */
const epochsWords = (seal: SealedCompletion, scopes: ReadonlyArray<CaptureScopeRef>): string => {
  const words = scopes.map((scope) =>
    scope.worktreeId === seal.worktreeId ? `${scope.epoch}` : `${scope.worktreeId}:${scope.epoch}`,
  );
  return words.length === 1 ? `epoch ${words[0]}` : `epochs ${words.join(", ")}`;
};

/** Seal read-backs in flight (`sealStandingOf`), by store, seal and the authority it waited out. */
const readBacks = makeSingleFlight<SealStanding, never>();

/**
 * Whether `seal` stands. On a bucket that refuses to replace an object (`BlobStore.replaceableUntil`
 * answers 0: S3, R2, MinIO, the directory store) its bytes stay those bytes, and the seal stands as
 * recorded. On one that does not (Garage ignores `If-None-Match`), an upload URL handed out under
 * any epoch its objects live under could replace an object until it expires — the seal's own and
 * every earlier one whose packs it carries (`scopes`, cross-repo decision 31) — the latest such
 * expiry is recorded before any URL is handed out (`CaptureStoreRepo.recordPutAuthority`), and the
 * store adds what this process minted and a URL minted before it started could still do. So:
 * - while any such URL could still be used: withheld;
 * - once none can, every object the sealed capture names is read back (`storedCaptureProblem`):
 *   all what their names say → it is marked re-verified from the moment the read began, and
 *   stands until another URL is handed out under one of those epochs. The mark is a
 *   compare-and-set against all of that authority (`markSealReverified`): a URL handed out while
 *   the objects were being read back voids the read, and the seal stays withheld. Any other
 *   bytes → void, for good;
 * - a store that could not be read concludes nothing: withheld, asked again on the next read.
 */
export const sealStandingOf = Effect.fn("CaptureSeals.sealStandingOf")(function* (
  seal: SealedCompletion,
  now: () => number,
) {
  const repo = yield* CaptureStoreRepo;
  const blobs = yield* BlobStore;
  const annotations = {
    worktreeId: seal.worktreeId,
    epoch: seal.epoch,
    n: seal.n,
    captureId: seal.captureId,
  };
  const voidReason = seal.voidReason ?? null;
  if (voidReason !== null)
    return { state: "void", code: "void", reason: voidReason } satisfies SealStanding;
  const row = yield* repo.captureById(seal.captureId);
  if (row === null) {
    return {
      state: "withheld",
      code: "verifying",
      reason: "the sealed capture is not registered",
    } satisfies SealStanding;
  }
  // Every object the capture lists, not only its manifest: the store remembers URLs by key.
  const listed = [row.manifestKey, ...keysOfSections(row.sections)];
  let storeUntil = 0;
  for (const key of listed) storeUntil = Math.max(storeUntil, yield* blobs.replaceableUntil(key));
  if (storeUntil === 0) return { state: "standing" } satisfies SealStanding;
  // Every epoch its objects live under — an inherited pack's included (cross-repo decision 31,
  // review 2026-09-28 (10) #5): a URL of an earlier epoch could replace that pack as surely as
  // one of the seal's own.
  const scopes = seal.scopes ?? [{ worktreeId: seal.worktreeId, epoch: seal.epoch }];
  const recorded = yield* repo.putAuthorityUntilOver(scopes);
  const until = Math.max(storeUntil, recorded?.getTime() ?? 0);
  const at = now();
  if (at < until) {
    const words = `an upload URL of ${epochsWords(seal, scopes)} could replace what it names until ${new Date(until).toISOString()}`;
    yield* Effect.logInfo(
      "capture seals: sealed, but an upload URL of its epoch could still replace what it names · withheld until it expires",
    ).pipe(
      Effect.annotateLogs({ ...annotations, replaceableUntil: new Date(until).toISOString() }),
    );
    return { state: "withheld", code: "write-authority", reason: words } satisfies SealStanding;
  }
  const reverified = seal.reverifiedAt?.getTime() ?? null;
  if (reverified !== null && reverified >= until)
    return { state: "standing" } satisfies SealStanding;
  // One read-back per seal and authority at a time (e2e8 F2): the engine's attestations and the
  // executor's re-asks ask together, and a caller that gives up leaves it running for the next.
  const readBack = Effect.gen(function* () {
    const problem = yield* storedCaptureProblem(row.manifestKey).pipe(
      Effect.provideService(BlobStore, blobs),
      Effect.result,
    );
    if (problem._tag === "Failure") {
      yield* Effect.logWarning(
        "capture seals: sealed, but its objects could not be read back · withheld",
      ).pipe(Effect.annotateLogs({ ...annotations, error: problem.failure.message }));
      return {
        state: "withheld",
        code: "verifying",
        reason: `its objects could not be read back: ${problem.failure.message}`,
      } satisfies SealStanding;
    }
    if (problem.success !== null) {
      yield* repo.voidSeal(seal.worktreeId, seal.epoch, seal.captureId, problem.success);
      yield* Effect.logError(
        "capture seals: an object the seal names read back as other bytes · the seal is void",
      ).pipe(Effect.annotateLogs({ ...annotations, problem: problem.success }));
      return { state: "void", code: "void", reason: problem.success } satisfies SealStanding;
    }
    // Marked only if no URL of the epoch was handed out since the read began (`at`).
    const marked = yield* repo.markSealReverified(
      seal.worktreeId,
      seal.epoch,
      seal.captureId,
      new Date(at),
    );
    if (!marked) {
      yield* Effect.logWarning(
        "capture seals: an upload URL of its epoch was handed out while its objects were read back · withheld",
      ).pipe(Effect.annotateLogs(annotations));
      return {
        state: "withheld",
        code: "write-authority",
        reason: `an upload URL of ${epochsWords(seal, scopes)} was handed out while its objects were read back`,
      } satisfies SealStanding;
    }
    return { state: "standing" } satisfies SealStanding;
  });
  return yield* readBacks.run(
    [blobs.identity, seal.worktreeId, seal.epoch, seal.captureId, until].join("\u0000"),
    null,
    readBack.pipe(
      Effect.provideService(CaptureStoreRepo, repo),
      Effect.provideService(BlobStore, blobs),
    ),
  );
});

/**
 * The store's seals as they stand (`sealStandingOf`): a recorded seal is answered only while it
 * stands; withheld or void, the answer is null — nothing reads saved on it.
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
        const standing = yield* sealStandingOf(seal, now).pipe(
          Effect.provideService(CaptureStoreRepo, repo),
          Effect.provideService(BlobStore, blobs),
        );
        return standing.state === "standing" ? seal : null;
      });
      return { sealedCompletion };
    }),
  );

/** `makeCaptureSealsStore` on the wall clock: what the API provides beside the capture store. */
export const CaptureSealsStoreLive: Layer.Layer<CaptureSeals, never, CaptureStoreRepo | BlobStore> =
  makeCaptureSealsStore();
