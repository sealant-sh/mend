import { NewBriefComment, NewIssue, QueueMove } from "@mend/api-contracts";
import { IssueId, RunId } from "@mend/domain";
import { Effect, Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Queue-era surface: issues · briefs · runs. */
export const queueRouter = router({
  listIssues: procedure.query(({ ctx }) => run(ctx, (api) => api.issues.list())),
  issueDetail: procedure
    .input(input(Schema.Struct({ id: IssueId })))
    .query(({ ctx, input: i }) => run(ctx, (api) => api.issues.detail({ params: { id: i.id } }))),
  createIssue: procedure
    .input(input(NewIssue))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.issues.create({ payload }))),
  moveIssue: procedure
    .input(input(Schema.Struct({ id: IssueId, move: QueueMove })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.issues.move({ params: { id: i.id }, payload: i.move })),
    ),
  runDetail: procedure
    .input(input(Schema.Struct({ id: RunId })))
    .query(({ ctx, input: i }) => run(ctx, (api) => api.runs.detail({ params: { id: i.id } }))),
  runTrace: procedure
    .input(input(Schema.Struct({ id: RunId, from: Schema.optional(Schema.String) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.runs.trace({ params: { id: i.id }, query: { from: i.from } })),
    ),
  runSources: procedure
    .input(input(Schema.Struct({ id: RunId })))
    .query(({ ctx, input: i }) => run(ctx, (api) => api.runs.sources({ params: { id: i.id } }))),
  briefByIssue: procedure
    .input(input(Schema.Struct({ issueId: IssueId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.briefs.byIssue({ params: { id: i.issueId } }).pipe(
          // "No brief yet" is a state, not an error.
          Effect.catchTag("NotFound", () => Effect.succeed(null)),
        ),
      ),
    ),
  listBriefComments: procedure
    .input(input(Schema.Struct({ issueId: IssueId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.briefs.comments({ params: { id: i.issueId } })),
    ),
  postBriefComment: procedure
    .input(input(Schema.Struct({ issueId: IssueId, comment: NewBriefComment })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.briefs.comment({ params: { id: i.issueId }, payload: i.comment })),
    ),
  briefVersions: procedure
    .input(input(Schema.Struct({ issueId: IssueId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.briefs.versions({ params: { id: i.issueId } })),
    ),
});
