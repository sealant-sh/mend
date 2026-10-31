import { ChangeId, ReviewCommentId, ReviewSliceId } from "@mend/domain";
import { ChangePass, ChangeTour, ReviewComment } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { ChangeDiff } from "./sessions.ts";
import {
  ChangeStats,
  NewSliceReviewCommentRequest,
  OpenReviewRequest,
  OpenReviewResult,
  ReviewDiffView,
  SetCommentStateRequest,
} from "./sessions.ts";
import { RemovalInProgress, StoreFailure } from "./workbench-views.ts";

export const sessionChangesGroup = HttpApiGroup.make("sessionChanges")
  .add(
    HttpApiEndpoint.post("openReview", "/changes/:id/reviews/open", {
      params: { id: ChangeId },
      payload: OpenReviewRequest,
      success: OpenReviewResult,
      error: [NotFound, StoreFailure, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("reviewDiff", "/changes/:id/reviews/:sliceId/diff", {
      params: { id: ChangeId, sliceId: ReviewSliceId },
      query: {
        whitespace: Schema.optional(Schema.Literals(["include", "ignore"])),
        context: Schema.optional(Schema.String),
      },
      success: ReviewDiffView,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("sliceComment", "/changes/:id/reviews/:sliceId/comments", {
      params: { id: ChangeId, sliceId: ReviewSliceId },
      payload: NewSliceReviewCommentRequest,
      success: ReviewComment,
      error: [NotFound, StoreFailure, RemovalInProgress],
    }),
  )
  .add(
    /** Retained temporarily for legacy clients; new Review surfaces use explicit slices. */
    HttpApiEndpoint.get("diff", "/changes/:id/diff", {
      params: { id: ChangeId },
      success: ChangeDiff,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.get("stats", "/changes/:id/stats", {
      params: { id: ChangeId },
      success: ChangeStats,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.get("comments", "/changes/:id/comments", {
      params: { id: ChangeId },
      success: Schema.Array(ReviewComment),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("commentState", "/changes/:id/comments/:commentId/state", {
      params: { id: ChangeId, commentId: ReviewCommentId },
      payload: SetCommentStateRequest,
      success: ReviewComment,
      error: [NotFound, RemovalInProgress],
    }),
  )
  .add(
    // "Read this change" (plan §7.3): queue the machine pass; findings land
    // asynchronously as draft comments and arrive over the normal SSE path.
    HttpApiEndpoint.post("read", "/changes/:id/read", {
      params: { id: ChangeId },
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: [NotFound, RemovalInProgress],
    }),
  )
  .add(
    // The composed review tour: null until composed; SSE announces arrival.
    HttpApiEndpoint.get("tour", "/changes/:id/tour", {
      params: { id: ChangeId },
      success: Schema.NullOr(ChangeTour),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("composeTour", "/changes/:id/tour", {
      params: { id: ChangeId },
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: [NotFound, RemovalInProgress],
    }),
  )
  .add(
    // The suggestion pass: queue it; suggestions land asynchronously as
    // draft comments carrying exact replacements, over the normal SSE path.
    HttpApiEndpoint.post("suggest", "/changes/:id/suggest", {
      params: { id: ChangeId },
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: [NotFound, RemovalInProgress],
    }),
  )
  .add(
    // What ran over this change and what came of it — one row per pass kind.
    HttpApiEndpoint.get("passes", "/changes/:id/passes", {
      params: { id: ChangeId },
      success: Schema.Array(ChangePass),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/**
 * Adoption discovery: the host's GitHub CLI answers with the credentials it
 * already holds — Mend adds none of its own. What was observed about gh
 * (missing, signed out) is status content, never a hidden error; clients fall
 * back to a typed source. No new product noun — this is still adoption.
 */
export class GhStatusView extends Schema.Class<GhStatusView>("GhStatusView")({
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  /** The account gh reports as active, when signed in. */
  login: Schema.NullOr(Schema.String),
  /** The CLI's own words when discovery cannot serve — verbatim, never rephrased. */
  detail: Schema.NullOr(Schema.String),
}) {}

/** One repository exactly as gh reported it (list and search shapes normalized). */
export class GhRepoView extends Schema.Class<GhRepoView>("GhRepoView")({
  nameWithOwner: Schema.String,
  description: Schema.NullOr(Schema.String),
  visibility: Schema.String,
  isFork: Schema.Boolean,
  language: Schema.NullOr(Schema.String),
  stars: Schema.Int,
  pushedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
}) {}

/** A gh invocation that could not answer — its stderr, verbatim. */
export class GhFailure extends Schema.TaggedError<GhFailure>()(
  "GhFailure",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}
