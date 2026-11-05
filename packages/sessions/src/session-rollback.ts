import type { RollbackWorker, SessionHistoryRepo } from "@mend/db";
import { HistoryWorkerContext } from "@mend/db";
import type {
  HistoryNativeBinding,
  RollbackOperation,
  RollbackProgress,
  RollbackRecovery,
  TurnBoundary,
} from "@mend/domain/workbench";
import { RollbackRefusedError } from "@mend/domain/workbench";
import { Effect } from "effect";

import {
  inspectRollbackFiles,
  retainRollbackFileEvidence,
  restoreRollbackFiles,
  saveRollbackRecovery,
  verifyRollbackUnchanged,
  compareRollbackFiles,
  type RollbackFileAuthority,
  type RollbackFilesError,
} from "./rollback-files.ts";

/** Engine-owned live operations. The host retains all native publication authority. */
export interface RollbackRuntime {
  readonly stopTarget: Effect.Effect<void, RollbackRefusedError>;
  readonly files: Effect.Effect<RollbackFileAuthority, RollbackRefusedError>;
  readonly checkpointSaved: (
    recovery: RollbackRecovery,
  ) => Effect.Effect<void, RollbackRefusedError>;
  /** Returns only after the host verified the candidate and every candidate writer exited. */
  readonly prepareNative: (
    operation: RollbackOperation,
    boundary: TurnBoundary,
    existing: HistoryNativeBinding | null,
  ) => Effect.Effect<HistoryNativeBinding, RollbackRefusedError>;
  readonly flush: Effect.Effect<string | null, RollbackRefusedError>;
  readonly candidateFiles: (binding: HistoryNativeBinding) => RollbackFileAuthority;
  readonly publish: (
    binding: HistoryNativeBinding,
    commit: Effect.Effect<RollbackOperation, RollbackRefusedError>,
  ) => Effect.Effect<RollbackOperation, RollbackRefusedError>;
}

type Stage = Exclude<
  RollbackProgress,
  { readonly kind: "complete" | "failed" | "recoveryRequired" }
>;
const refused = (message: string) =>
  new RollbackRefusedError({ code: "recovery_required", message });

/** One continuation of the durable receipt, never a turn, queue, timer or independent scheduler. */
export const continueSessionRollback = (
  claimed: RollbackOperation,
  token: string,
  history: SessionHistoryRepo["Service"],
  makeRuntime: (
    check: (files?: boolean) => Effect.Effect<void, RollbackRefusedError>,
  ) => Effect.Effect<RollbackRuntime, RollbackRefusedError>,
): Effect.Effect<RollbackOperation> =>
  Effect.gen(function* () {
    let operation = claimed;
    const actor = operation.recoveryAttempt?.actorId ?? operation.actorId;
    const worker = (): RollbackWorker => ({
      operationId: operation.id,
      token,
      generation: operation.generation,
      version: operation.version,
    });
    const check = (files = operation.intent.restoreFiles) =>
      history.checkRollbackWorker(worker(), actor, files).pipe(Effect.asVoid);
    const advance = (progress: Exclude<RollbackProgress, { readonly kind: "complete" }>) =>
      Effect.gen(function* () {
        const next = yield* history.advanceRollback(worker(), progress);
        if (next === null)
          return yield* refused(
            "A newer continuation owns this rollback. Read its receipt before retrying.",
          );
        operation = next;
      });
    let recovery = yield* history.recovery(operation.id);
    let evidenceAuthority: RollbackFileAuthority | null = null;
    const resume =
      operation.progress.kind === "recoveryRequired" ? operation.progress.resume : undefined;
    const execution = Effect.gen(function* () {
      yield* check();
      if (operation.progress.kind === "complete" || operation.progress.kind === "failed")
        return operation;
      const runtime = yield* makeRuntime(check);
      yield* runtime.stopTarget;
      const supplied = yield* runtime.files;
      const files: RollbackFileAuthority = {
        ...supplied,
        execute: (argv) => check().pipe(Effect.andThen(supplied.execute(argv))),
      };
      evidenceAuthority = files;
      if (operation.recoveryAttempt?.action === "restoreSaved") {
        if (recovery === null)
          return yield* refused(
            "The original save is not retained. Finish saving before restoring it.",
          );
        yield* check(true);
        // The runtime stopped every prior writer before this recovery could claim its generation.
        yield* restoreRollbackFiles(files, "restoreSaved");
        yield* verifyRollbackUnchanged(files, recovery);
        yield* runtime.flush;
        const proof = yield* retainRollbackFileEvidence(files);
        if (operation.progress.kind !== "recoveryRequired")
          yield* advance({
            kind: "recoveryRequired",
            recoveryId: recovery.id,
            reason: {
              code: "recovery_required",
              message: "Restored the original saved files and staging.",
            },
            resume: operation.progress,
          });
        return yield* history.releaseRollback(
          worker(),
          actor,
          {
            code: "recovery_required",
            message:
              "The original files and staging were restored. The original conversation remains active.",
          },
          proof,
        );
      }
      if (operation.progress.kind === "recoveryRequired") {
        if (resume === undefined)
          return yield* refused(
            "This operation has no verified continuation stage. Use restoreSaved after its writers have exited.",
          );
        yield* advance(resume);
      }
      if (operation.progress.kind === "admitted") yield* advance({ kind: "saving" });
      if (operation.progress.kind === "saving") {
        if (recovery === null) {
          recovery = yield* saveRollbackRecovery(files);
          if (!(yield* history.saveRecovery(worker(), recovery)))
            return yield* refused(
              "The original recovery save could not be committed. Its retained bytes were preserved.",
            );
        }
        yield* runtime.checkpointSaved(recovery);
        yield* runtime.flush;
        yield* advance({ kind: "saved", recoveryId: recovery.id });
      }
      if (recovery === null)
        return yield* refused("The independently retained original save is unavailable.");
      const boundary = yield* history.boundary(operation.intent.targetBoundaryId);
      if (boundary === null)
        return yield* refused("The exact retained rollback boundary is unavailable.");
      if (operation.progress.kind === "saved")
        yield* advance({ kind: "preparingNative", recoveryId: recovery.id });
      const stage = operation.progress;
      if (
        stage.kind === "recoveryRequired" ||
        stage.kind === "admitted" ||
        stage.kind === "saving" ||
        stage.kind === "saved"
      )
        return yield* refused("This receipt is not at a native preparation stage.");
      const existing = "candidate" in stage ? stage.candidate : null;
      // A resumed partial journal is observed as-is. Initialization cannot change that observation.
      const beforeNative = yield* inspectRollbackFiles(files);
      const candidate = yield* runtime.prepareNative(operation, boundary, existing);
      evidenceAuthority = runtime.candidateFiles(candidate);
      if ((yield* inspectRollbackFiles(files)) !== beforeNative)
        return yield* refused(
          "Native initialization changed managed files or staging. Both histories and the original save remain retained.",
        );
      if (stage.kind === "preparingNative") {
        yield* verifyRollbackUnchanged(files, recovery);
        yield* advance({ kind: "nativeReady", recoveryId: recovery.id, candidate });
      }
      if (operation.intent.restoreFiles) {
        if (operation.progress.kind === "nativeReady")
          yield* advance({ kind: "restoringFiles", recoveryId: recovery.id, candidate });
        if (operation.progress.kind === "restoringFiles") {
          yield* check(true);
          yield* restoreRollbackFiles(files);
        }
      } else yield* verifyRollbackUnchanged(files, recovery);
      const { changed: filesChanged } = yield* compareRollbackFiles(files, recovery);
      yield* runtime.flush;
      if (operation.progress.kind !== "readyToPublish") {
        const evidence = yield* retainRollbackFileEvidence(runtime.candidateFiles(candidate));
        yield* advance({
          kind: "readyToPublish",
          recoveryId: recovery.id,
          candidate,
          evidence,
          evidenceDigest: evidence.sha256,
          filesChanged,
        });
      }
      yield* check();
      return yield* runtime.publish(candidate, history.publishRollback(worker()));
    });
    return yield* execution.pipe(
      Effect.provideService(HistoryWorkerContext, {
        operationId: claimed.id,
        token,
        generation: claimed.generation,
      }),
      Effect.catch((error: RollbackRefusedError | RollbackFilesError) =>
        Effect.gen(function* () {
          const progress = operation.progress;
          if (progress.kind === "complete" || progress.kind === "failed") return operation;
          const stage: Stage | undefined =
            progress.kind === "recoveryRequired" ? progress.resume : progress;
          // Read-only evidence is attempted only with current authority and an original durable save.
          const observedEvidence =
            evidenceAuthority === null || recovery === null
              ? null
              : yield* check().pipe(
                  Effect.andThen(retainRollbackFileEvidence(evidenceAuthority)),
                  Effect.catch(() => Effect.succeed(null)),
                );
          yield* advance({
            kind: "recoveryRequired",
            recoveryId: recovery?.id ?? null,
            ...(stage === undefined ? {} : { resume: stage }),
            ...(observedEvidence === null ? {} : { observedEvidence }),
            reason:
              error._tag === "RollbackRefusedError"
                ? { code: error.code, message: error.message }
                : { code: "file_conflict", message: error.message },
          });
          return operation;
        }).pipe(
          Effect.catch(() =>
            history.rollback(operation.id).pipe(Effect.map((current) => current ?? operation)),
          ),
        ),
      ),
    );
  });
