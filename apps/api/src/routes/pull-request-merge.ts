import { CurrentUser, MendApi } from "@mend/api-contracts";
import { PullRequestWorkspaces } from "@mend/landing";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { mergeGitHubPullRequest, readGitHubMergeAccess } from "../pull-request-merge.ts";

/** Project visibility first; GitHub decides the caller's authority to merge. */
export const PullRequestMergeGroupLive = HttpApiBuilder.group(
  MendApi,
  "pullRequestMerge",
  (handlers) =>
    handlers
      .handle("access", ({ params, query }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).project(params.id);
          const caller = yield* CurrentUser;
          return yield* readGitHubMergeAccess(
            yield* PullRequestWorkspaces,
            caller.user.id,
            query.repository,
            params.number,
          );
        }),
      )
      .handle("merge", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).project(params.id);
          const caller = yield* CurrentUser;
          yield* mergeGitHubPullRequest(
            yield* PullRequestWorkspaces,
            caller.user.id,
            params.number,
            payload,
          );
        }),
      ),
);
