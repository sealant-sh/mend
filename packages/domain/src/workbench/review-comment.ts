import { Schema } from "effect";

import {
  ChangeId,
  CheckpointId,
  FollowUpId,
  ReviewCommentId,
  ReviewSliceId,
  SessionId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { AgentTurnStatus } from "./agent-protocol.ts";
import { DiffDigest } from "./review-slice.ts";

/** Who wrote it: the human reviewer, or Mend ("Mend reads the change", §7.3). */
export const CommentAuthor = Schema.Literals(["reviewer", "mend"]);
export type CommentAuthor = typeof CommentAuthor.Type;

/**
 * `draft` exists only for Mend-authored findings awaiting accept/dismiss —
 * a reviewer's comment is born `open`. `addressed` is set when a follow-up
 * settles and the anchored hunk changed; it is an observation, not a verdict.
 */
export const CommentState = Schema.Literals(["draft", "open", "addressed", "dismissed"]);
export type CommentState = typeof CommentState.Type;

/**
 * A finding's link back to the session record: `(sealantRunId, sequence)`
 * addresses the exact timeline entry; the excerpt is denormalized so the
 * comment renders without a platform round-trip. The workbench analogue of
 * the queue-era EvidencePointer — sessions are backed by platform runs, so
 * the run id here is the platform's, not a Mend row id.
 */
export class RecordLink extends Schema.Class<RecordLink>("RecordLink")({
  sealantRunId: Schema.String,
  // BigInt in the domain, a decimal string on every wire — sequences can
  // pass 2^53 and JSON has no bigint.
  sequence: Schema.BigIntFromString,
  excerpt: Schema.String,
}) {}

/**
 * What the comment is: a `note` states an observation; a `suggestion` also
 * carries a concrete replacement for the anchored lines (the suggestion
 * pass's output — strict by contract, accepted or dismissed like any draft).
 */
export const CommentKind = Schema.Literals(["note", "suggestion"]);
export type CommentKind = typeof CommentKind.Type;

export const ReviewAnchorSide = Schema.Literals(["old", "new"]);
export type ReviewAnchorSide = typeof ReviewAnchorSide.Type;

export const ReviewAnchorMapping = Schema.Literals(["anchored", "moved", "not-found"]);
export type ReviewAnchorMapping = typeof ReviewAnchorMapping.Type;

/**
 * A comment target bound to one immutable Review slice. Null paths and lines represent a
 * change-level target; paths with null lines represent a file-level target. The hunk context hash
 * makes line anchors fail visibly instead of silently drifting when clients map them later.
 */
export class ReviewCommentAnchor extends Schema.Class<ReviewCommentAnchor>("ReviewCommentAnchor")({
  reviewSliceId: ReviewSliceId,
  checkpointAId: CheckpointId,
  checkpointBId: CheckpointId,
  diffDigest: DiffDigest,
  oldPath: Schema.NullOr(Schema.String),
  newPath: Schema.NullOr(Schema.String),
  side: Schema.NullOr(ReviewAnchorSide),
  startLine: Schema.NullOr(Schema.Int),
  endLine: Schema.NullOr(Schema.Int),
  hunkContextHash: Schema.NullOr(Schema.String),
  mapping: ReviewAnchorMapping,
}) {}

/**
 * Where a comment sits on one Review slice: carried from the checkpoint it was written on, through
 * git's diff, to the same side of this slice (the "to" checkpoint for the new side, the "from"
 * checkpoint for the old). `anchored`: its lines are where they were; `moved`: other edits moved
 * them, or an edit rewrote them (`linesChanged`, and `startLine`/`endLine` are the lines that
 * replaced them); `not-found`: an edit only deleted them, or their file is gone, so the comment is
 * no longer placed in the diff. Lines are null on a file or whole-change comment, and on
 * `not-found`. Whether the lines show in the slice's hunks is the client's to read.
 */
export class ReviewCommentPlacement extends Schema.Class<ReviewCommentPlacement>(
  "ReviewCommentPlacement",
)({
  reviewSliceId: ReviewSliceId,
  mapping: ReviewAnchorMapping,
  /** The file's path on this slice's side, after any rename. Null on a whole-change comment. */
  path: Schema.NullOr(Schema.String),
  side: Schema.NullOr(ReviewAnchorSide),
  startLine: Schema.NullOr(Schema.Int),
  endLine: Schema.NullOr(Schema.Int),
  /** An edit between the comment's checkpoint and this slice rewrote its lines. */
  linesChanged: Schema.Boolean,
}) {}

/** What the code did after a comment was sent: observed in checkpoints, never a verdict. */
export const AnswerOutcome = Schema.Literals(["changed-code", "no-code-change"]);
export type AnswerOutcome = typeof AnswerOutcome.Type;

/** A checkpoint named in an answer, by id and by its number in the worktree's chain. */
export class AnswerCheckpoint extends Schema.Class<AnswerCheckpoint>("AnswerCheckpoint")({
  checkpointId: CheckpointId,
  ordinal: Schema.Int,
}) {}

/**
 * The agent's answer to a sent comment, read from the record rather than written by anyone: the
 * conversation turn its follow-up started, that turn's last message, and what happened to the
 * code the comment points at. Every comment of one follow-up carries the same turn's answer: the
 * turn answers them together, and Mend does not split its words. `outcome` is null while the turn
 * runs, before its closing checkpoint, and always on a whole-change comment (no edit can be tied
 * to it). `changed-code` names the first checkpoint after the send at which the comment's lines
 * (or file) differ.
 */
export class AgentAnswer extends Schema.Class<AgentAnswer>("AgentAnswer")({
  followUpId: FollowUpId,
  sessionId: SessionId,
  /** The session's harness, as the session records it (`claude`, `codex`, …). */
  harness: Schema.String,
  turnOrdinal: Schema.Int,
  turnStatus: AgentTurnStatus,
  /** The turn's last message; null until it has written one. */
  body: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(AnswerOutcome),
  changedAt: Schema.NullOr(AnswerCheckpoint),
  /** When the turn ended, or started while it runs. */
  at: Timestamp,
}) {}

const reviewCommentFields = {
  id: ReviewCommentId,
  changeId: ChangeId,
  /** Anchor: null file = change-level; null line = file-level. */
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Int),
  /** Inclusive range end; null = the comment anchors to `line` alone. */
  endLine: Schema.NullOr(Schema.Int),
  /** Null marks an honest legacy live-diff anchor. New reviewer comments always set this. */
  anchor: Schema.NullOr(ReviewCommentAnchor),
  authorKind: CommentAuthor,
  authorName: Schema.String,
  body: Schema.String,
  kind: CommentKind,
  /** The proposed replacement for the anchored lines — set only when kind is `suggestion`. */
  suggestion: Schema.NullOr(Schema.String),
  state: CommentState,
  /**
   * Links to the session record — non-empty on every record-grounded finding.
   * Suggestions are readings of the diff itself; theirs may be empty, and the
   * empty list is the honest "inferred reading" marker, never an omission.
   */
  evidence: Schema.Array(RecordLink),
  /** The session a bundled follow-up was sent to, once sent. */
  sentToSessionId: Schema.NullOr(SessionId),
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

/**
 * A person's reply to a comment: one level deep, at its comment's place. It is born `open` and
 * unsent, and goes to the agent with the next follow-up like any comment.
 */
export class ReviewReply extends Schema.Class<ReviewReply>("ReviewReply")({
  ...reviewCommentFields,
  parentId: ReviewCommentId,
}) {}

/**
 * Feedback anchored to a file, line, or the change as a whole (plan §5.7).
 * `file`/`line` null = change-level. Comments can stay notes, or be bundled
 * into a follow-up instruction and sent back to the session — the routed
 * decision is recorded on the comment that caused it.
 *
 * The thread fields are absent wherever a comment is read alone, and on servers before replies.
 * A list of a change's comments holds only comments (never replies), each with its thread.
 */
export class ReviewComment extends Schema.Class<ReviewComment>("ReviewComment")({
  ...reviewCommentFields,
  /** Set on a reply read alone (as `commentState` answers it); null or absent on a comment. */
  parentId: Schema.optionalKey(Schema.NullOr(ReviewCommentId)),
  /** People's replies, oldest first. */
  replies: Schema.optionalKey(Schema.Array(ReviewReply)),
  /** The agent's answers, one per follow-up that carried this comment and started a turn. */
  answers: Schema.optionalKey(Schema.Array(AgentAnswer)),
  /** The number of the conversation turn this comment was sent in, when one started. */
  sentInTurn: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  /** Where it sits on the slice the list was asked for; absent when none was asked or legacy. */
  placement: Schema.optionalKey(ReviewCommentPlacement),
}) {}
