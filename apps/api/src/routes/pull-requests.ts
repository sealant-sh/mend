import { CurrentUser, MendApi, PullRequestReadFailed } from "@mend/api-contracts";
import { githubRepositoryOf } from "@mend/landing";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { ProjectPullRequests } from "../project-pull-requests.ts";

/** Project visibility is checked before the caller's GitHub account is used. */
export const PullRequestsGroupLive = HttpApiBuilder.group(MendApi, "pullRequests", (handlers) =>
  handlers
    .handle("identity", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* ProjectPullRequests).identity(caller.user.id);
      }),
    )
    .handle("list", ({ params, payload }) =>
      Effect.gen(function* () {
        const project = yield* (yield* ProjectAccess).project(params.id);
        const repository =
          project.originUrl === null ? null : githubRepositoryOf(project.originUrl);
        if (repository === null)
          return yield* new PullRequestReadFailed({
            message: "This project has no GitHub origin.",
          });
        const caller = yield* CurrentUser;
        return yield* (yield* ProjectPullRequests).list(caller.user.id, repository.slug, payload);
      }),
    )
    .handle("detail", ({ params, query }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.id);
        const caller = yield* CurrentUser;
        return yield* (yield* ProjectPullRequests).detail(
          caller.user.id,
          query.repository,
          params.number,
        );
      }),
    ),
);
