import { ProjectId } from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

/** A GitHub repository name, passed as data to the caller's own GitHub CLI. */
export const PullRequestRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
);

/** GitHub could not answer a PR read using the caller's connected account. */
export class PullRequestReadFailed extends Schema.TaggedError<PullRequestReadFailed>()(
  "PullRequestReadFailed",
  {
    message: Schema.String,
  },
  { httpApiStatus: 422 },
) {}

/** The actor GitHub returned; deleted accounts remain null on their PR. */
export const GitHubPullRequestActor = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

/** One observed check, including status contexts and check runs. */
export const GitHubPullRequestCheck = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals([
    "pending",
    "action-required",
    "success",
    "failure",
    "skipped",
    "neutral",
    "cancelled",
  ]),
  description: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});

/** PR facts observed as the caller, independent of a Mend landing. */
export const GitHubPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(GitHubPullRequestActor),
  headBranch: Schema.String,
  baseBranch: Schema.String,
  headSha: Schema.String,
  headRepository: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String),
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  reviewDecision: Schema.NullOr(
    Schema.Literals(["approved", "changes-requested", "review-required"]),
  ),
  labels: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.NullOr(Schema.String) })),
  checks: Schema.Array(GitHubPullRequestCheck),
  viewerCanUpdate: Schema.Boolean,
  observedAt: Schema.Number,
});
export type GitHubPullRequest = typeof GitHubPullRequest.Type;

/** One host page, with its continuation cursor and the login that read it. */
export const GitHubPullRequestPage = Schema.Struct({
  viewer: Schema.String,
  entries: Schema.Array(GitHubPullRequest),
  cursor: Schema.NullOr(Schema.String),
});
export type GitHubPullRequestPage = typeof GitHubPullRequestPage.Type;

/** A bounded page search scoped to one visible project and the caller's GitHub rights. */
export const PullRequestSearch = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(2000)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
});
export type PullRequestSearch = typeof PullRequestSearch.Type;

/** PR browsing always uses the signed-in person's GitHub account. */
export const pullRequestsGroup = HttpApiGroup.make("pullRequests")
  .add(
    HttpApiEndpoint.get("identity", "/github/pull-request-identity", {
      success: Schema.Struct({ viewer: Schema.String }),
      error: PullRequestReadFailed,
    }),
  )
  .add(
    HttpApiEndpoint.post("list", "/projects/:id/pull-requests/search", {
      params: { id: ProjectId },
      payload: PullRequestSearch,
      success: GitHubPullRequestPage,
      error: [NotFound, PullRequestReadFailed, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/projects/:id/pull-requests/:number", {
      params: {
        id: ProjectId,
        number: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
      },
      query: { repository: PullRequestRepository },
      success: Schema.Struct({ viewer: Schema.String, pullRequest: GitHubPullRequest }),
      error: [NotFound, PullRequestReadFailed],
    }),
  )
  .middleware(AuthMiddleware);
