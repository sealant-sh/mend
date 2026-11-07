import { CurrentUser, MendApi, NotFound, StoreFailure } from "@mend/api-contracts";
import { ProjectLocalWorktrees } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { refuseStartWhileRemoving } from "../removal.ts";

/** Local uses ordinary project visibility; each conversation still launches as its own owner. */
export const ProjectLocalWorktreesGroupLive = HttpApiBuilder.group(
  MendApi,
  "projectLocalWorktrees",
  (handlers) =>
    handlers
      .handle("find", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).project(params.id);
          return yield* (yield* ProjectLocalWorktrees)
            .find(params.id)
            .pipe(
              Effect.catchTag("ProjectNotFoundError", () =>
                Effect.fail(new NotFound({ id: params.id })),
              ),
            );
        }),
      )
      .handle("start", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).project(params.id);
          yield* refuseStartWhileRemoving({ projectId: params.id, worktreeId: null });
          return yield* (yield* ProjectLocalWorktrees)
            .start(params.id, (yield* CurrentUser).user.id)
            .pipe(
              Effect.catchTag("ProjectNotFoundError", () =>
                Effect.fail(new NotFound({ id: params.id })),
              ),
              Effect.catchTag("GitError", (error) =>
                Effect.fail(new StoreFailure({ message: error.stderr })),
              ),
              Effect.catchTags({
                WorktreeNameTakenError: (error) =>
                  Effect.fail(new StoreFailure({ message: error.message })),
                WorktreeStartUnsupportedError: (error) =>
                  Effect.fail(new StoreFailure({ message: error.message })),
                WorktreeBaseConflictError: (error) =>
                  Effect.fail(
                    new StoreFailure({
                      message: `Local worktree "${error.name}" already exists with another base.`,
                    }),
                  ),
              }),
            );
        }),
      ),
);
