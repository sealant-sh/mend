import {
  type GitHubMergeAccess,
  type GitHubMergeRequest,
  PullRequestMergeFailed,
} from "@mend/api-contracts";
import { type PullRequestWorkspace, type PullRequestWorkspaces } from "@mend/landing";
import { Effect, Schema } from "effect";

import { removeAgentCredits } from "./pull-request-merge-message.ts";

const fail = (message: string) => new PullRequestMergeFailed({ message });
const State = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.NullOr(
      Schema.Struct({
        viewerPermission: Schema.NullOr(Schema.String),
        mergeCommitAllowed: Schema.Boolean,
        squashMergeAllowed: Schema.Boolean,
        rebaseMergeAllowed: Schema.Boolean,
        pullRequest: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            state: Schema.String,
            isDraft: Schema.Boolean,
            headRefOid: Schema.String,
            isMergeQueueEnabled: Schema.Boolean,
          }),
        ),
      }),
    ),
  }),
});
const Message = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            viewerMergeBodyText: Schema.String,
            headRefOid: Schema.String,
            isMergeQueueEnabled: Schema.Boolean,
          }),
        ),
      }),
    ),
  }),
});
const Mutation = Schema.Struct({
  data: Schema.Struct({
    mergePullRequest: Schema.optional(
      Schema.NullOr(Schema.Struct({ pullRequest: Schema.Struct({ id: Schema.String }) })),
    ),
    enablePullRequestAutoMerge: Schema.optional(
      Schema.NullOr(Schema.Struct({ pullRequest: Schema.Struct({ id: Schema.String }) })),
    ),
  }),
});
const Envelope = Schema.Struct({ errors: Schema.optional(Schema.Array(Schema.Unknown)) });
const READ = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login } repository(owner: $owner, name: $name) {
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number: $number) { id state isDraft headRefOid isMergeQueueEnabled }
  }
}`;
const MESSAGE = `query($owner: String!, $name: String!, $number: Int!, $method: PullRequestMergeMethod!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    viewerMergeBodyText(mergeType: $method) headRefOid isMergeQueueEnabled
  } }
}`;
const MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID, $body: String) {
  mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head, commitBody: $body }) {
    pullRequest { id }
  }
}`;
const QUEUE = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { id } }
}`;

const graphql = <A>(
  workspace: PullRequestWorkspace,
  schema: Schema.Decoder<A>,
  query: string,
  variables: Readonly<Record<string, string | number>>,
) =>
  Effect.gen(function* () {
    const output = yield* workspace.exec([
      "env",
      "GH_PROMPT_DISABLED=1",
      "GH_TELEMETRY=0",
      "GH_NO_UPDATE_NOTIFIER=1",
      "NO_COLOR=1",
      "gh",
      "api",
      "graphql",
      "--hostname=github.com",
      "-f",
      `query=${query}`,
      ...Object.entries(variables).flatMap(([key, value]) => [
        typeof value === "number" ? "-F" : "-f",
        `${key}=${value}`,
      ]),
    ]);
    if (output.exitCode !== 0) {
      yield* Effect.logWarning("GitHub refused an explicit pull request operation").pipe(
        Effect.annotateLogs({ exitCode: output.exitCode }),
      );
      return yield* fail(
        "GitHub could not complete this request using your connected account. Check your permissions and the pull request's requirements on GitHub.",
      );
    }
    const decode = <B>(decoder: Schema.Decoder<B>) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(decoder))(output.stdout).pipe(
        Effect.mapError(() =>
          fail("GitHub returned an incomplete response. Open the pull request again."),
        ),
      );
    const envelope = yield* decode(Envelope);
    if ((envelope.errors?.length ?? 0) > 0)
      return yield* fail(
        "GitHub refused this request. Check the pull request's requirements on GitHub.",
      );
    return yield* decode(schema);
  });

const selectors = (repository: string, number: number) => {
  const [owner = "", name = ""] = repository.split("/");
  return { owner, name, number };
};
const accessOf = (data: (typeof State.Type)["data"]): GitHubMergeAccess => {
  const repo = data.repository;
  const mergeMethods: Array<GitHubMergeAccess["mergeMethods"][number]> = [];
  if (repo?.mergeCommitAllowed === true) mergeMethods.push("merge");
  if (repo?.squashMergeAllowed === true) mergeMethods.push("squash");
  if (repo?.rebaseMergeAllowed === true) mergeMethods.push("rebase");
  return {
    viewer: data.viewer.login,
    canMerge: ["WRITE", "MAINTAIN", "ADMIN"].includes(repo?.viewerPermission ?? ""),
    mergeMethods,
  };
};

/** Fresh merge capabilities, using the caller's short-lived GitHub workspace only. */
export const readGitHubMergeAccess = (
  workspaces: PullRequestWorkspaces["Service"],
  userId: string,
  repository: string,
  number: number,
): Effect.Effect<GitHubMergeAccess, PullRequestMergeFailed> =>
  workspaces
    .within({ ownerUserId: userId, sessionId: null }, (workspace) =>
      Effect.gen(function* () {
        const { data } = yield* graphql(workspace, State, READ, selectors(repository, number));
        if (data.repository?.pullRequest == null)
          return yield* fail("This pull request is not visible to your GitHub account.");
        return accessOf(data);
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof PullRequestMergeFailed
          ? error
          : fail(
              "Mend could not use your connected GitHub account. Connect GitHub in Mend and try again.",
            ),
      ),
    );

/** Recheck account, repository methods and rights before the one person-requested mutation. */
export const mergeGitHubPullRequest = (
  workspaces: PullRequestWorkspaces["Service"],
  userId: string,
  number: number,
  input: GitHubMergeRequest,
): Effect.Effect<void, PullRequestMergeFailed> =>
  workspaces
    .within({ ownerUserId: userId, sessionId: null }, (workspace) =>
      Effect.gen(function* () {
        const variables = selectors(input.repository, number);
        const { data } = yield* graphql(workspace, State, READ, variables);
        const pr = data.repository?.pullRequest;
        if (pr == null)
          return yield* fail("This pull request is not visible to your GitHub account.");
        if (
          input.expectedAccountId !== undefined &&
          input.expectedAccountId.toLowerCase() !== data.viewer.login.toLowerCase()
        )
          return yield* fail("Your GitHub account changed. Open the pull request again.");
        const access = accessOf(data);
        if (!access.canMerge)
          return yield* fail(
            "Your GitHub account does not have permission to merge this pull request.",
          );
        const method = input.method ?? "merge";
        if (!access.mergeMethods.includes(method))
          return yield* fail(`This repository does not allow the ${method} merge method.`);
        if (pr.state !== "OPEN" || pr.isDraft)
          return yield* fail("Only an open pull request that is ready for review can be merged.");
        let body: string | undefined;
        let head: string | undefined;
        // T3 v0.1.2 defaults this off. A merge queue chooses its own message.
        if (input.removeAgentCredits === true && method !== "rebase" && !pr.isMergeQueueEnabled) {
          const message = (yield* graphql(workspace, Message, MESSAGE, {
            ...variables,
            method: method.toUpperCase(),
          })).data.repository?.pullRequest;
          if (message == null)
            return yield* fail("This pull request is no longer visible to your GitHub account.");
          if (!message.isMergeQueueEnabled) {
            const cleaned = removeAgentCredits(message.viewerMergeBodyText);
            if (cleaned !== message.viewerMergeBodyText) {
              body = cleaned;
              head = message.headRefOid;
            }
          }
        }
        const result = yield* graphql(workspace, Mutation, pr.isMergeQueueEnabled ? QUEUE : MERGE, {
          id: pr.id,
          method: method.toUpperCase(),
          ...(body === undefined ? {} : { body }),
          ...(head === undefined ? {} : { head }),
        });
        const merged = pr.isMergeQueueEnabled
          ? result.data.enablePullRequestAutoMerge
          : result.data.mergePullRequest;
        if (merged?.pullRequest.id !== pr.id)
          return yield* fail(
            "GitHub did not confirm this merge. Check the pull request before trying again.",
          );
      }),
    )
    .pipe(
      Effect.mapError((error) =>
        error instanceof PullRequestMergeFailed
          ? error
          : fail(
              "Mend could not use your connected GitHub account. Connect GitHub in Mend and try again.",
            ),
      ),
    );
