import { Schema } from "effect";

import {
  AgentTurnId,
  CheckpointId,
  OrganizationId,
  SealantRunId,
  SessionId,
  Sha,
  WorktreeId,
} from "../ids.ts";
import { SequenceNumber, Timestamp } from "../timestamp.ts";
import { AgentItemKind, AgentItemStatus, AgentTurnStatus } from "./agent-protocol.ts";
import { NativeSeedId } from "./native-history.ts";
export {
  NativeFileRef,
  NativeHistorySeed,
  NativeHistoryObservation,
  NativeSeedId,
  NativeTurnCutoff,
} from "./native-history.ts";
import { TurnSelection } from "./turn-selection.ts";

/** An immutable pairing of native conversation history and a worktree checkpoint. */
export const TurnBoundaryId = Schema.String.pipe(Schema.brand("TurnBoundaryId"));
export type TurnBoundaryId = typeof TurnBoundaryId.Type;
/** A durable receipt for a person's keyed history command, never a turn scheduler. */
export const HistoryOperationId = Schema.String.pipe(Schema.brand("HistoryOperationId"));
export type HistoryOperationId = typeof HistoryOperationId.Type;

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const NativeId = Schema.String.check(Schema.isPattern(/\S/));

/** Exact saved history paired with the observed HEAD, rather than a checkpoint-chain commit. */
export const TurnBoundary = Schema.Struct({
  id: TurnBoundaryId,
  sessionId: SessionId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  anchor: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("turn"), turnId: AgentTurnId }),
    Schema.Struct({ kind: Schema.Literal("forkBase"), sourceBoundaryId: TurnBoundaryId }),
  ]),
  checkpointId: CheckpointId,
  nativeSeedId: NativeSeedId,
  selection: TurnSelection,
  gitHead: Sha,
  observedAt: Timestamp,
  nativeObservedAt: Timestamp,
  record: Schema.Struct({ runId: SealantRunId, seq: SequenceNumber }),
});
export type TurnBoundary = typeof TurnBoundary.Type;

/** Why an observed turn cannot be forked. Old turns are never timestamp-backfilled. */
export const BoundaryUnavailableReason = Schema.Literals([
  "native_history_missing",
  "native_boundary_unknown",
  "capture_not_caught_up",
  "checkpoint_failed",
  "unsupported_native_format",
]);
export type BoundaryUnavailableReason = typeof BoundaryUnavailableReason.Type;
/** Ready evidence or a durable refusal for one exact Mend turn. */
export const BoundaryObservation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready"), boundary: TurnBoundary }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    sessionId: SessionId,
    turnId: AgentTurnId,
    reason: BoundaryUnavailableReason,
  }),
]);
export type BoundaryObservation = typeof BoundaryObservation.Type;

/** Display evidence has original provenance and no dispatch, payer, process or cost ownership. */
export const InheritedHistory = Schema.Array(
  Schema.Struct({
    sourceSessionId: SessionId,
    sourceTurnId: AgentTurnId,
    ordinal: Schema.Int,
    author: Schema.NullOr(Schema.String),
    input: Schema.String,
    status: AgentTurnStatus,
    selection: Schema.NullOr(TurnSelection),
    createdAt: Timestamp,
    endedAt: Schema.NullOr(Timestamp),
    items: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        kind: AgentItemKind,
        status: AgentItemStatus,
        title: Schema.NullOr(Schema.String),
        text: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
export type InheritedHistory = typeof InheritedHistory.Type;

/** Source identities remain as provenance after the source is deleted. */
export const ForkProvenance = Schema.Struct({
  childSessionId: SessionId,
  sourceSessionId: SessionId,
  rootSessionId: SessionId,
  sourceBoundaryId: TurnBoundaryId,
  sourceTurnId: Schema.NullOr(AgentTurnId),
  sourceCheckpointId: CheckpointId,
  sourceNativeSeedId: NativeSeedId,
  inheritedViewDigest: Digest,
  requestedBy: Schema.String,
  requestedAt: Timestamp,
});
export type ForkProvenance = typeof ForkProvenance.Type;

/** A selector resolves once when a keyed command is admitted. */
export const ForkPoint = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("turn"), turnId: AgentTurnId }),
  Schema.Struct({ kind: Schema.Literal("checkpoint"), checkpointId: CheckpointId }),
  Schema.Struct({ kind: Schema.Literal("latestStable") }),
]);
export type ForkPoint = typeof ForkPoint.Type;

/** The normalized command excludes subsequently resolved defaults. */
export const ForkRequest = Schema.Struct({
  sourceSessionId: SessionId,
  at: ForkPoint,
  title: Schema.NullOr(Schema.String),
});
export type ForkRequest = typeof ForkRequest.Type;

/** Closed fork preparation states, separate from AgentTurn execution. */
export const HistoryProgress = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("preparing") }),
  Schema.Struct({ kind: Schema.Literal("awaitingNative") }),
  Schema.Struct({ kind: Schema.Literal("complete"), providerSessionId: NativeId }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: Schema.String,
    retryable: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("recoveryRequired"), reason: Schema.String }),
]);
export type HistoryProgress = typeof HistoryProgress.Type;

/** Durable fork intent and allocated targets survive a lost response or server restart. */
export const HistoryOperation = Schema.Struct({
  id: HistoryOperationId,
  organizationId: OrganizationId,
  actorId: Schema.String,
  commandId: Schema.String,
  intentDigest: Digest,
  request: ForkRequest,
  intent: Schema.Struct({
    kind: Schema.Literal("fork"),
    sourceBoundaryId: TurnBoundaryId,
    childSessionId: SessionId,
    childWorktreeId: WorktreeId,
  }),
  progress: HistoryProgress,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type HistoryOperation = typeof HistoryOperation.Type;

/** A known selection, including its inner nulls, takes precedence over launch defaults. */
export function forkSelectionOf(
  selected: TurnSelection | null,
  defaults: TurnSelection,
): TurnSelection {
  return selected ?? defaults;
}

/** A history command cannot preserve the requested conversation. Nothing is silently replaced. */
export class SessionHistoryRefusedError extends Schema.TaggedError<SessionHistoryRefusedError>()(
  "SessionHistoryRefusedError",
  {
    reason: Schema.Literals([
      "boundary_unavailable",
      "login_required",
      "forbidden",
      "unsupported",
      "command_conflict",
      "preparing",
      "preparation_failed",
    ]),
    message: Schema.String,
  },
) {}
