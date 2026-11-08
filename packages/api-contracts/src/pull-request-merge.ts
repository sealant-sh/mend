import { ProjectId } from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

const Repository = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u));
const Method = Schema.Literals(["merge", "squash", "rebase"]);
const Params = {
  id: ProjectId,
  number: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
};

/** GitHub's currently allowed merge methods and the connected person's repository rights. */
export const GitHubMergeAccess = Schema.Struct({
  viewer: Schema.String,
  canMerge: Schema.Boolean,
  mergeMethods: Schema.Array(Method),
});
export type GitHubMergeAccess = typeof GitHubMergeAccess.Type;

/** One explicit person-requested merge; no landing, agent turn or worktree mutation. */
export const GitHubMergeRequest = Schema.Struct({
  repository: Repository,
  method: Schema.optional(Method),
  expectedAccountId: Schema.optional(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  ),
  removeAgentCredits: Schema.optional(Schema.Boolean),
});
export type GitHubMergeRequest = typeof GitHubMergeRequest.Type;

/** A permission, account, repository-policy or upstream refusal to an explicit merge request. */
export class PullRequestMergeFailed extends Schema.TaggedError<PullRequestMergeFailed>()(
  "PullRequestMergeFailed",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Remote merges use project visibility and the caller's own GitHub authorization. */
export const pullRequestMergeGroup = HttpApiGroup.make("pullRequestMerge")
  .add(
    HttpApiEndpoint.get("access", "/projects/:id/pull-requests/:number/merge-access", {
      params: Params,
      query: { repository: Repository },
      success: GitHubMergeAccess,
      error: [NotFound, PullRequestMergeFailed],
    }),
  )
  .add(
    HttpApiEndpoint.post("merge", "/projects/:id/pull-requests/:number/merge", {
      params: Params,
      payload: GitHubMergeRequest,
      success: HttpApiSchema.NoContent,
      error: [NotFound, PullRequestMergeFailed, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
