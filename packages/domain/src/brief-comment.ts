import { Schema } from "effect";

import { BriefCommentId, BriefId, RunId } from "./ids.ts";
import { Timestamp } from "./timestamp.ts";

export const CommentAuthorKind = Schema.Literals(["reviewer", "mend"]);
export type CommentAuthorKind = typeof CommentAuthorKind.Type;

/**
 * What Mend decided a reviewer comment asks for (docs/archive/PRODUCT.md, Iteration):
 * a follow-up run on the same branch, a question back, or a verification pass.
 * Recorded on the comment itself, so the routing is visible evidence.
 */
export const RoutedAction = Schema.Literals(["follow-up-run", "verification-run", "question-back"]);
export type RoutedAction = typeof RoutedAction.Type;

export const routedActionLabel: Record<RoutedAction, string> = {
  "follow-up-run": "started a follow-up run",
  "verification-run": "started a verification pass",
  "question-back": "asked back",
};

/**
 * One entry in a brief's review conversation. Threads anchor to a review
 * question (`q<index>`) or to the brief as a whole (`general`). Reviewer
 * comments carry the routed decision once Mend has read them; Mend's own
 * replies are `mend`-authored entries in the same thread.
 */
export class BriefComment extends Schema.Class<BriefComment>("BriefComment")({
  id: BriefCommentId,
  briefId: BriefId,
  thread: Schema.String,
  authorKind: CommentAuthorKind,
  authorName: Schema.String,
  body: Schema.String,
  routedAction: Schema.NullOr(RoutedAction),
  routedRunId: Schema.NullOr(RunId),
  createdAt: Timestamp,
}) {}
