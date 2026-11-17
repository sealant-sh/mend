import { CheckpointRequest, NewWorktree, NewWorktreeSession } from "@mend/api-contracts";
import { ProjectId, WorktreeId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: WorktreeId }));

/** The worktree container: the durable place sessions are conversations inside. */
export const worktreesRouter = router({
  list: procedure
    .input(input(Schema.Struct({ projectId: ProjectId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.list({ params: { id: i.projectId } })),
    ),
  detail: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.detail({ params: { id: i.id } })),
    ),
  previews: procedure
    .input(byId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.previews({ params: { id: i.id } })),
    ),
  create: procedure
    .input(input(Schema.Struct({ projectId: ProjectId, worktree: NewWorktree })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.create({ params: { id: i.projectId }, payload: i.worktree })),
    ),
  remove: procedure
    .input(input(Schema.Struct({ id: WorktreeId, force: Schema.optional(Schema.Boolean) })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.worktrees.remove({
          params: { id: i.id },
          query: i.force === true ? { force: "true" } : {},
        }),
      ),
    ),
  createSession: procedure
    .input(input(Schema.Struct({ id: WorktreeId, session: NewWorktreeSession })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.createSession({ params: { id: i.id }, payload: i.session })),
    ),
  checkpoint: procedure
    .input(input(Schema.Struct({ id: WorktreeId, request: CheckpointRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.checkpoint({ params: { id: i.id }, payload: i.request })),
    ),
});
