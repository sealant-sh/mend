import {
  NewSliceReviewCommentRequest,
  OpenReviewRequest,
  SetCommentStateRequest,
} from "@mend/api-contracts";
import { ChangeId, ReviewCommentId, ReviewSliceId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: ChangeId }));

/** Changes · review. */
export const changesRouter = router({
  proofArtifacts: procedure
    .input(input(Schema.Struct({ changeId: ChangeId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.proofArtifacts.listForChange({ params: { changeId: i.changeId } })),
    ),
  stats: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.stats({ params: { id: i.id } })),
    ),
  diff: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.diff({ params: { id: i.id } })),
    ),
  openReview: procedure
    .input(input(Schema.Struct({ id: ChangeId, request: OpenReviewRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessionChanges.openReview({ params: { id: i.id }, payload: i.request }),
      ),
    ),
  reviewDiff: procedure
    .input(input(Schema.Struct({ id: ChangeId, sliceId: ReviewSliceId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessionChanges.reviewDiff({ params: { id: i.id, sliceId: i.sliceId }, query: {} }),
      ),
    ),
  comments: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.comments({ params: { id: i.id } })),
    ),
  postSliceComment: procedure
    .input(
      input(
        Schema.Struct({
          id: ChangeId,
          sliceId: ReviewSliceId,
          comment: NewSliceReviewCommentRequest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessionChanges.sliceComment({
          params: { id: i.id, sliceId: i.sliceId },
          payload: i.comment,
        }),
      ),
    ),
  setCommentState: procedure
    .input(
      input(
        Schema.Struct({
          id: ChangeId,
          commentId: ReviewCommentId,
          request: SetCommentStateRequest,
        }),
      ),
    )
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.sessionChanges.commentState({
          params: { id: i.id, commentId: i.commentId },
          payload: i.request,
        }),
      ),
    ),
  tour: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.tour({ params: { id: i.id } })),
    ),
  passes: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.passes({ params: { id: i.id } })),
    ),
  queueRead: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.read({ params: { id: i.id } })),
    ),
  queueTour: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.composeTour({ params: { id: i.id } })),
    ),
  queueSuggest: procedure
    .input(byId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.sessionChanges.suggest({ params: { id: i.id } })),
    ),
});
