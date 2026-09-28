import type { WorktreeId } from "@mend/domain";
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
  readonly sealedAt: Date;
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
 * runtime (`apps/api/src/main.ts`). Where nothing provides it — the co-located store, tests —
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
