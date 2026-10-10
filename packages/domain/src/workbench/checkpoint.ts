import { Schema } from "effect";

import { CheckpointId, SealantRunId, SessionId, Sha, WorktreeId } from "../ids.ts";
import { SequenceNumber, Timestamp } from "../timestamp.ts";

/** What caused a checkpoint to be taken (plan §5.6 "Checkpoints and slices"). */
export const CheckpointTrigger = Schema.Literals([
  "session-start",
  "command-settle",
  "turn-boundary",
  "review-open",
  "user-mark",
]);
export type CheckpointTrigger = typeof CheckpointTrigger.Type;

/** Which of a Stop's own readings a checkpoint taken during that Stop came from. */
export const CheckpointSourceKind = Schema.Literals(["stop-final", "stop-reading"]);
export type CheckpointSourceKind = typeof CheckpointSourceKind.Type;

/**
 * Where a checkpoint's view of the executor came from when it was not observed for the checkpoint
 * itself (mend#649). A review or a mark asked while a Stop was ending the executor is taken from
 * the Stop's own flush instead of asking the executor again: `stop-final`, the Stop's final save;
 * `stop-reading`, a reading the Stop took that did not save. `captureN` is the head that flush
 * reported (null: none reported, as when the store's seal stood for a lost answer), and
 * `observedAt` when Mend received it. The checkpoint's own `createdAt` is later: it says when the
 * snapshot was recorded, never when the disk was read.
 */
export class CheckpointSource extends Schema.Class<CheckpointSource>("CheckpointSource")({
  kind: CheckpointSourceKind,
  captureN: Schema.NullOr(Schema.Int),
  observedAt: Timestamp,
}) {}

/**
 * How a checkpoint's source reads, with `at` its `observedAt` as the client formats it:
 * `from the Stop's final save · capture 12 · 10:18`. Evidence of where the snapshot came from,
 * never a fresh observation.
 */
export const checkpointSourceWords = (
  source: { readonly kind: CheckpointSourceKind; readonly captureN: number | null },
  at: string,
): string =>
  [
    source.kind === "stop-final"
      ? "from the Stop's final save"
      : "from a Stop reading that did not save",
    ...(source.captureN === null ? [] : [`capture ${source.captureN}`]),
    at,
  ].join(" · ");

/**
 * A cheap snapshot of the worktree — a commit on a hidden ref that never
 * touches the visible branch — stamped with the exact record pointer current when it was
 * taken. The `(ref, sealantRunId, seq)` tuple joins the two truths: git carries what changed, the
 * record carries why. Sequence numbers restart for every Sealant run. The chain belongs to the
 * worktree: checkpoints from every session in it share one ordinal sequence, and any two define
 * a reviewable slice.
 */
export class Checkpoint extends Schema.Class<Checkpoint>("Checkpoint")({
  id: CheckpointId,
  worktreeId: WorktreeId,
  /**
   * Provenance: the conversation whose activity triggered the snapshot. Null
   * for worktree-level triggers (the worktree-start checkpoint, review opened
   * with no live session) and for checkpoints whose session was deleted.
   */
  sessionId: Schema.NullOr(SessionId),
  /** Position in the worktree's chain, dense from 0 (the worktree-start checkpoint). */
  ordinal: Schema.Int,
  /**
   * Hidden ref: `refs/mend/checkpoints/<worktreeId>/<ordinal>` for new rows;
   * legacy rows keep their stored session-scoped refs, which stay resolvable.
   */
  ref: Schema.String,
  sha: Sha,
  /** Null only before the session's first platform run, or on honest legacy gaps. */
  sealantRunId: Schema.NullOr(SealantRunId),
  /** Record sequence the supervisor had seen when the snapshot was taken. */
  seq: SequenceNumber,
  trigger: CheckpointTrigger,
  createdAt: Timestamp,
  /** Absent when the checkpoint observed the executor itself (`CheckpointSource`). */
  source: Schema.optionalKey(CheckpointSource),
}) {}
