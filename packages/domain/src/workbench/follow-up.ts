import { Schema } from "effect";

import {
  ChangeId,
  CheckpointId,
  FollowUpId,
  ReviewCommentId,
  ReviewSliceId,
  SealantRunId,
  SessionId,
  SessionProcessId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { DiffDigest } from "./review-slice.ts";

/**
 * `pending` — persisted and waiting for a settled session.
 * `delivering` — the server owns a launch attempt; retries reconcile by correlation.
 * `delivered` — the platform accepted the exact instruction and Mend persisted membership.
 * `delivery_failed` — no accepted process was found; the same key may retry.
 * `superseded` — a newer bundle replaced it before delivery began.
 */
/** The longest instruction Mend takes for one follow-up, in UTF-16 code units. */
export const FOLLOW_UP_INSTRUCTION_MAX = 100_000;

export const FollowUpStatus = Schema.Literals([
  "pending",
  "delivering",
  "delivered",
  "delivery_failed",
  "superseded",
]);
export type FollowUpStatus = typeof FollowUpStatus.Type;

/**
 * A review bundle sent back to the session (plan §7.3): the comments
 * assembled into one instruction, inspected and edited by the user before
 * sending — never fired blind. Today delivery is `mend continue` relaunching
 * the harness in the same worktree; when the platform ships PTY input, the
 * same row feeds the live session instead.
 */
export class FollowUp extends Schema.Class<FollowUp>("FollowUp")({
  id: FollowUpId,
  sessionId: SessionId,
  changeId: ChangeId,
  /** Immutable Review input. Null only on legacy bundles created before slices shipped. */
  reviewSliceId: Schema.NullOr(ReviewSliceId),
  checkpointAId: Schema.NullOr(CheckpointId),
  checkpointBId: Schema.NullOr(CheckpointId),
  diffDigest: Schema.NullOr(DiffDigest),
  /** Exactly the reviewer-selected comments; legacy bundles decode as an empty list. */
  commentIds: Schema.Array(ReviewCommentId),
  /** Client retry key. Null only on legacy bundles. */
  idempotencyKey: Schema.NullOr(Schema.String),
  /** The instruction as the user approved it — verbatim what the harness receives. */
  instruction: Schema.String,
  status: FollowUpStatus,
  /** Durable launch correlation, populated only after process membership exists. */
  deliveryProcessId: Schema.NullOr(SessionProcessId),
  deliverySealantRunId: Schema.NullOr(SealantRunId),
  deliveryError: Schema.NullOr(Schema.String),
  deliveryStartedAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  deliveredAt: Schema.NullOr(Timestamp),
}) {}
