import {
  type GitHubPullRequest,
  type GitHubPullRequestPage,
  PullRequestReadFailed,
  type PullRequestSearch,
} from "@mend/api-contracts";
import { PullRequestWorkspaces, type PullRequestWorkspace } from "@mend/landing";
import { Clock, Context, Effect, Layer, Schema } from "effect";

/** GitHub reads run as the caller, without borrowing any session owner's workspace. */
export class ProjectPullRequests extends Context.Service<
  ProjectPullRequests,
  {
    readonly identity: (
      userId: string,
    ) => Effect.Effect<{ readonly viewer: string }, PullRequestReadFailed>;
    readonly list: (
      userId: string,
      repository: string,
      search: PullRequestSearch,
    ) => Effect.Effect<GitHubPullRequestPage, PullRequestReadFailed>;
    readonly detail: (
      userId: string,
      repository: string,
      number: number,
    ) => Effect.Effect<
      { readonly viewer: string; readonly pullRequest: GitHubPullRequest },
      PullRequestReadFailed
    >;
  }
>()("@mend/api/ProjectPullRequests") {}

const Actor = Schema.Struct({ login: Schema.String, avatarUrl: Schema.NullOr(Schema.String) });
const Check = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.NullOr(Schema.String),
    detailsUrl: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    __typename: Schema.Literal("StatusContext"),
    context: Schema.String,
    state: Schema.String,
    description: Schema.NullOr(Schema.String),
    targetUrl: Schema.NullOr(Schema.String),
  }),
]);
const HostPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  url: Schema.String,
  author: Schema.NullOr(Actor),
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  headRepository: Schema.NullOr(Schema.Struct({ nameWithOwner: Schema.String })),
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String),
  mergeable: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  viewerCanUpdate: Schema.Boolean,
  labels: Schema.Struct({
    pageInfo: Schema.optional(Schema.Struct({ hasNextPage: Schema.Boolean })),
    nodes: Schema.Array(
      Schema.Struct({ name: Schema.String, color: Schema.NullOr(Schema.String) }),
    ),
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(
            Schema.Struct({
              contexts: Schema.Struct({
                nodes: Schema.Array(Check),
                pageInfo: Schema.optional(Schema.Struct({ hasNextPage: Schema.Boolean })),
              }),
            }),
          ),
        }),
      }),
    ),
  }),
});

const FIELDS = `number title body url author { login avatarUrl } headRefName baseRefName headRefOid
  headRepository { nameWithOwner } state isDraft additions deletions changedFiles createdAt updatedAt closedAt mergedAt
  mergeable reviewDecision viewerCanUpdate labels(first: 100) { pageInfo { hasNextPage } nodes { name color } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
    __typename ... on CheckRun { name status conclusion detailsUrl }
    ... on StatusContext { context state description targetUrl }
  } } } } } }`;
const LIST_QUERY = `query($search: String!, $limit: Int!, $cursor: String) {
  viewer { login } search(query: $search, type: ISSUE, first: $limit, after: $cursor) {
    nodes { ... on PullRequest { ${FIELDS} } } pageInfo { hasNextPage endCursor }
  }
}`;
const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login } repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${FIELDS} } }
}`;
const ListResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    search: Schema.Struct({
      nodes: Schema.Array(HostPullRequest),
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
    }),
  }),
});
const DetailResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.Struct({ pullRequest: HostPullRequest }),
  }),
});

const checkStatus = (value: string): GitHubPullRequest["checks"][number]["status"] => {
  switch (value) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
      return "failure";
    case "ACTION_REQUIRED":
      return "action-required";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "NEUTRAL":
      return "neutral";
    default:
      return "pending";
  }
};
const pullRequestOf = (pr: typeof HostPullRequest.Type, observedAt: number): GitHubPullRequest => ({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  url: pr.url,
  author: pr.author === null ? null : { ...pr.author, name: null },
  headBranch: pr.headRefName,
  baseBranch: pr.baseRefName,
  headSha: pr.headRefOid,
  headRepository: pr.headRepository?.nameWithOwner ?? null,
  state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
  isDraft: pr.isDraft,
  additions: pr.additions,
  deletions: pr.deletions,
  changedFiles: pr.changedFiles,
  createdAt: pr.createdAt,
  updatedAt: pr.updatedAt,
  closedAt: pr.closedAt,
  mergedAt: pr.mergedAt,
  mergeability:
    pr.mergeable === "MERGEABLE"
      ? "mergeable"
      : pr.mergeable === "CONFLICTING"
        ? "conflicting"
        : "unknown",
  reviewDecision:
    pr.reviewDecision === "APPROVED"
      ? "approved"
      : pr.reviewDecision === "CHANGES_REQUESTED"
        ? "changes-requested"
        : pr.reviewDecision === "REVIEW_REQUIRED"
          ? "review-required"
          : null,
  labels: pr.labels.nodes,
  checks: pr.commits.nodes
    .flatMap((entry) => entry.commit.statusCheckRollup?.contexts.nodes ?? [])
    .map((check) =>
      check["__typename"] === "CheckRun"
        ? {
            name: check.name,
            status: checkStatus(
              check.status === "COMPLETED" ? (check.conclusion ?? "") : check.status,
            ),
            description: null,
            url: check.detailsUrl,
          }
        : {
            name: check.context,
            status: checkStatus(check.state),
            description: check.description,
            url: check.targetUrl,
          },
    ),
  viewerCanUpdate: pr.viewerCanUpdate,
  observedAt,
});

const query = <A>(
  workspace: PullRequestWorkspace,
  args: ReadonlyArray<string>,
  schema: Schema.Codec<A>,
) =>
  workspace.exec(["gh", "api", "graphql", ...args]).pipe(
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? Effect.fail(
            new PullRequestReadFailed({
              message: `GitHub PR read failed (exit ${result.exitCode}).`,
            }),
          )
        : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(result.stdout).pipe(
            Effect.mapError(
              () =>
                new PullRequestReadFailed({
                  message: "GitHub returned an incomplete or invalid PR response.",
                }),
            ),
          ),
    ),
  );

const completeRead = (pr: typeof HostPullRequest.Type) =>
  pr.labels.pageInfo?.hasNextPage === true ||
  pr.commits.nodes.some(
    (entry) => entry.commit.statusCheckRollup?.contexts.pageInfo?.hasNextPage === true,
  )
    ? Effect.fail(
        new PullRequestReadFailed({
          message:
            "This PR has more than 100 checks or labels. Read the complete result on GitHub.",
        }),
      )
    : Effect.void;

const make: Effect.Effect<ProjectPullRequests["Service"], never, PullRequestWorkspaces> =
  Effect.gen(function* () {
    const workspaces = yield* PullRequestWorkspaces;
    const list: ProjectPullRequests["Service"]["list"] = Effect.fn("ProjectPullRequests.list")(
      function* (userId, repository, search) {
        return yield* workspaces
          .within({ ownerUserId: userId, sessionId: null }, (workspace) =>
            Effect.gen(function* () {
              const result = yield* query(
                workspace,
                [
                  "-f",
                  `query=${LIST_QUERY}`,
                  "-f",
                  `search=repo:${repository} is:pr ${search.query}`,
                  "-F",
                  `limit=${search.limit}`,
                  ...(search.cursor === null ? [] : ["-f", `cursor=${search.cursor}`]),
                ],
                ListResponse,
              );
              yield* Effect.forEach(result.data.search.nodes, completeRead);
              const now = yield* Clock.currentTimeMillis;
              return {
                viewer: result.data.viewer.login,
                entries: result.data.search.nodes.map((pr) => pullRequestOf(pr, now)),
                cursor: result.data.search.pageInfo.hasNextPage
                  ? result.data.search.pageInfo.endCursor
                  : null,
              };
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "PullRequestReadFailed"
                ? error
                : new PullRequestReadFailed({ message: error.message }),
            ),
          );
      },
    );
    const detail: ProjectPullRequests["Service"]["detail"] = Effect.fn(
      "ProjectPullRequests.detail",
    )(function* (userId, repository, number) {
      const [owner = "", name = ""] = repository.split("/");
      return yield* workspaces
        .within({ ownerUserId: userId, sessionId: null }, (workspace) =>
          Effect.gen(function* () {
            const result = yield* query(
              workspace,
              [
                "-f",
                `query=${DETAIL_QUERY}`,
                "-f",
                `owner=${owner}`,
                "-f",
                `name=${name}`,
                "-F",
                `number=${number}`,
              ],
              DetailResponse,
            );
            yield* completeRead(result.data.repository.pullRequest);
            return {
              viewer: result.data.viewer.login,
              pullRequest: pullRequestOf(
                result.data.repository.pullRequest,
                yield* Clock.currentTimeMillis,
              ),
            };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "PullRequestReadFailed"
              ? error
              : new PullRequestReadFailed({ message: error.message }),
          ),
        );
    });
    const identity: ProjectPullRequests["Service"]["identity"] = (userId) =>
      workspaces
        .within({ ownerUserId: userId, sessionId: null }, (workspace) =>
          query(
            workspace,
            ["-f", "query=query { viewer { login } }"],
            Schema.Struct({
              data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) }),
            }),
          ).pipe(Effect.map((result) => ({ viewer: result.data.viewer.login }))),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "PullRequestReadFailed"
              ? error
              : new PullRequestReadFailed({ message: error.message }),
          ),
        );
    return { identity, list, detail };
  });

/** Uses the existing owner-scoped workspace capability; it never invokes the host's gh. */
export const ProjectPullRequestsLive: Layer.Layer<
  ProjectPullRequests,
  never,
  PullRequestWorkspaces
> = Layer.effect(ProjectPullRequests, make);
