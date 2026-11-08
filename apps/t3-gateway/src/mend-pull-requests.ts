import * as Schema from "effect/Schema";

/** The actor GitHub returned; deleted accounts remain null on their PR. */
export const MendPullRequestActor = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

/** One observed check, including status contexts and check runs. */
export const MendPullRequestCheck = Schema.Struct({
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
export const MendPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(MendPullRequestActor),
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
  checks: Schema.Array(MendPullRequestCheck),
  viewerCanUpdate: Schema.Boolean,
  observedAt: Schema.Number,
});
export type MendPullRequest = typeof MendPullRequest.Type;

/** One host page, with its continuation cursor and the login that read it. */
export const MendPullRequestPage = Schema.Struct({
  viewer: Schema.String,
  entries: Schema.Array(MendPullRequest),
  cursor: Schema.NullOr(Schema.String),
});
export type MendPullRequestPage = typeof MendPullRequestPage.Type;

/** A bounded page search scoped to one visible project and the caller's GitHub rights. */
export const PullRequestSearch = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(2000)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))),
});
export type PullRequestSearch = typeof PullRequestSearch.Type;

/** A detail read identifies the GitHub account that observed it. */
export const MendPullRequestDetail = Schema.Struct({
  viewer: Schema.String,
  pullRequest: MendPullRequest,
});
export type MendPullRequestDetail = typeof MendPullRequestDetail.Type;

/** Mend's stored tour. Coordinates describe the new file at its diff digest. */
export const MendChangeTour = Schema.Struct({
  summary: Schema.String,
  approach: Schema.NullOr(Schema.String),
  diffDigest: Schema.String,
  createdAt: Schema.String,
  stops: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      file: Schema.NullOr(Schema.String),
      line: Schema.NullOr(Schema.Int),
      endLine: Schema.NullOr(Schema.Int),
      narration: Schema.String,
      grounded: Schema.Boolean,
      evidence: Schema.Array(
        Schema.Struct({
          sealantRunId: Schema.String,
          sequence: Schema.String,
          excerpt: Schema.String,
        }),
      ),
    }),
  ),
});
export type MendChangeTour = typeof MendChangeTour.Type;
/** Durable status of Mend's tour pass, including a queued or failed pass. */
export const MendChangePass = Schema.Struct({
  kind: Schema.String,
  status: Schema.String,
  detail: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type MendChangePass = typeof MendChangePass.Type;
