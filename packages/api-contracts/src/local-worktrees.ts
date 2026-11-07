import { ProjectId } from "@mend/domain";
import { Worktree } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress, StoreFailure } from "./workbench-views.ts";

/** Read without provisioning, or explicitly start the project's one shared Local worktree. */
export const projectLocalWorktreesGroup = HttpApiGroup.make("projectLocalWorktrees")
  .add(
    HttpApiEndpoint.get("find", "/projects/:id/local-worktree", {
      params: { id: ProjectId },
      success: Schema.NullOr(Worktree),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("start", "/projects/:id/local-worktree", {
      params: { id: ProjectId },
      success: Worktree,
      error: [NotFound, StoreFailure, RemovalInProgress],
    }),
  )
  .middleware(AuthMiddleware);
