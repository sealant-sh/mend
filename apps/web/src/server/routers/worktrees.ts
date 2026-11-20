import { CheckpointRequest, NewWorktree, NewWorktreeSession } from "@mend/api-contracts";
import { CheckpointId, ProjectId, WorktreeId } from "@mend/domain";
import { Effect, Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byId = input(Schema.Struct({ id: WorktreeId }));

/** How many of a slice's changed files the browser is told by path. */
const SLICE_PATHS = 3;

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
  /**
   * Which files changed between two checkpoints of the worktree (`from` left out: its base), for
   * the conversation's line after a turn. Only the count and the first few paths cross to the
   * browser, not the patches. Both ends are fixed commits, so the answer never changes.
   */
  sliceFiles: procedure
    .input(
      input(
        Schema.Struct({
          id: WorktreeId,
          from: Schema.optional(CheckpointId),
          to: CheckpointId,
        }),
      ),
    )
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.worktrees
          .diff({
            params: { id: i.id },
            query: i.from === undefined ? { to: i.to } : { from: i.from, to: i.to },
          })
          .pipe(
            Effect.map((slice) => ({
              count: slice.files.length,
              /** The worktree changed more files than Mend listed in time. */
              more: slice.listingCut,
              paths: slice.files
                .slice(0, SLICE_PATHS)
                .map((file) => file.newPath ?? file.oldPath ?? ""),
            })),
          ),
      ),
    ),
  checkpoint: procedure
    .input(input(Schema.Struct({ id: WorktreeId, request: CheckpointRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.worktrees.checkpoint({ params: { id: i.id }, payload: i.request })),
    ),
});
