import { Schema } from "effect";

import {
  AgentTurnId,
  CheckpointId,
  OrganizationId,
  ProjectId,
  SessionId,
  WorktreeId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { HistoryOperationId, TurnBoundaryId } from "./session-history-ids.ts";

const Nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/** The exact history and shared-file generation against which a message was written. */
export const HistoryPosition = Schema.Struct({
  historyRevision: Nonnegative,
  worktreeEpoch: Nonnegative,
});
export type HistoryPosition = typeof HistoryPosition.Type;

/** A rollback names retained evidence, never a timestamp or a caller-provided path. */
export const RollbackRequest = Schema.Struct({
  sessionId: SessionId,
  at: Schema.Struct({ checkpointId: CheckpointId, boundaryId: TurnBoundaryId }),
  expected: HistoryPosition,
  restoreFiles: Schema.optional(Schema.Boolean),
});
export type RollbackRequest = typeof RollbackRequest.Type;

/** An independently retained pre-rollback save. */
export const RollbackRecoveryId = Schema.String.pipe(Schema.brand("RollbackRecoveryId"));
export type RollbackRecoveryId = typeof RollbackRecoveryId.Type;

/** A native replacement has its own saved location and no dispatchable user turn. */
export const HistoryNativeBinding = Schema.Struct({
  provider: Schema.Literals(["codex", "claude"]),
  providerSessionId: Schema.String.check(Schema.isPattern(/\S/)),
  ownerId: Schema.String,
  key: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
  verifiedDigest: Digest,
});
export type HistoryNativeBinding = typeof HistoryNativeBinding.Type;

/** Observed failures keep their operation fenced whenever a writer or file outcome is uncertain. */
export const RollbackFailure = Schema.Struct({
  code: Schema.Literals([
    "boundary_unavailable",
    "stale_revision",
    "busy",
    "queued_work",
    "forbidden",
    "login_required",
    "unsupported_native_format",
    "unsupported_file_state",
    "file_conflict",
    "save_incomplete",
    "native_preparation_failed",
    "authority_uncertain",
    "actor_revoked",
    "command_conflict",
    "recovery_required",
  ]),
  message: Schema.String,
});
export type RollbackFailure = typeof RollbackFailure.Type;

/** Completed rollback evidence leaves original execution statuses and cost intact. */
export const RollbackResult = Schema.Struct({
  recoveryId: RollbackRecoveryId,
  targetBoundaryId: TurnBoundaryId,
  position: HistoryPosition,
  files: Schema.Literals(["restored", "unchanged"]),
  native: Schema.Literals(["replaced", "already_at_boundary"]),
  publishedAt: Timestamp,
});
export type RollbackResult = typeof RollbackResult.Type;

const Saved = { recoveryId: RollbackRecoveryId };
const Prepared = { ...Saved, candidate: HistoryNativeBinding };
/** Preparation progress is durable history state, separate from the turn scheduler. */
export const RollbackProgress = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("admitted") }),
  Schema.Struct({ kind: Schema.Literal("saving") }),
  Schema.Struct({ kind: Schema.Literal("saved"), ...Saved }),
  Schema.Struct({ kind: Schema.Literal("preparingNative"), ...Saved }),
  Schema.Struct({ kind: Schema.Literal("nativeReady"), ...Prepared }),
  Schema.Struct({ kind: Schema.Literal("restoringFiles"), ...Prepared }),
  Schema.Struct({
    kind: Schema.Literal("readyToPublish"),
    ...Prepared,
    evidenceDigest: Digest,
    filesChanged: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("complete"), result: RollbackResult }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: RollbackFailure,
    recoveryId: Schema.NullOr(RollbackRecoveryId),
  }),
  Schema.Struct({
    kind: Schema.Literal("recoveryRequired"),
    reason: RollbackFailure,
    recoveryId: Schema.NullOr(RollbackRecoveryId),
  }),
]);
export type RollbackProgress = typeof RollbackProgress.Type;

/** The normalized receipt replays before checking a retry's newly observed position. */
export const RollbackOperation = Schema.Struct({
  id: HistoryOperationId,
  organizationId: OrganizationId,
  actorId: Schema.String,
  commandId: Schema.String,
  intentDigest: Digest,
  request: RollbackRequest,
  intent: Schema.Struct({
    kind: Schema.Literal("rollback"),
    sessionId: SessionId,
    projectId: ProjectId,
    worktreeId: WorktreeId,
    targetBoundaryId: TurnBoundaryId,
    from: HistoryPosition,
    toRevision: Nonnegative,
    restoreFiles: Schema.Boolean,
    removedTurnIds: Schema.Array(AgentTurnId),
    candidateKey: Schema.String,
  }),
  progress: RollbackProgress,
  version: Nonnegative,
  generation: Nonnegative,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type RollbackOperation = typeof RollbackOperation.Type;

/** Explicit send refusal preserves words with the caller instead of silently refreshing history. */
export class HistoryAdmissionRefusedError extends Schema.TaggedError<HistoryAdmissionRefusedError>()(
  "HistoryAdmissionRefusedError",
  {
    reason: Schema.Literals(["history_operation_in_progress", "stale_history"]),
    sessionId: SessionId,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** A rollback refusal has no permission to discard files, words or native evidence. */
export class RollbackRefusedError extends Schema.TaggedError<RollbackRefusedError>()(
  "RollbackRefusedError",
  {
    ...RollbackFailure.fields,
  },
  { httpApiStatus: 409 },
) {}
