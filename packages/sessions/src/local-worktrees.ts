import {
  ProjectLocalWorktreesRepo,
  type ProjectNotFoundError,
  ProjectsRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ProjectId } from "@mend/domain";
import type { Worktree } from "@mend/domain/workbench";
import { Context, Effect, Layer, Semaphore } from "effect";

import { SessionEngine } from "./engine.ts";

/** Failures of the engine's checkout, checkpoint, and change creation. */
export type LocalWorktreeStartError = Effect.Error<
  ReturnType<SessionEngine["Service"]["ensureWorktree"]>
>;

/** The one shared Local worktree, common to project previews and Local conversations. */
export class ProjectLocalWorktrees extends Context.Service<
  ProjectLocalWorktrees,
  {
    /** Read only. A project has no Local checkout until someone explicitly starts it. */
    readonly find: (projectId: ProjectId) => Effect.Effect<Worktree | null, ProjectNotFoundError>;
    /** Create once on the actual default branch; every later start preserves the checkout. */
    readonly start: (
      projectId: ProjectId,
      ownerUserId: string,
    ) => Effect.Effect<Worktree, LocalWorktreeStartError>;
  }
>()("@mend/sessions/ProjectLocalWorktrees") {}

/** Shares durable identity across callers; the session engine owns creation and its evidence. */
export const ProjectLocalWorktreesLive: Layer.Layer<
  ProjectLocalWorktrees,
  never,
  ProjectsRepo | WorktreesRepo | ProjectLocalWorktreesRepo | SessionEngine
> = Layer.effect(
  ProjectLocalWorktrees,
  Effect.gen(function* () {
    const projects = yield* ProjectsRepo;
    const worktrees = yield* WorktreesRepo;
    const allocations = yield* ProjectLocalWorktreesRepo;
    const engine = yield* SessionEngine;
    const starts = new Map<ProjectId, Semaphore.Semaphore>();
    const find = Effect.fn("ProjectLocalWorktrees.find")(function* (projectId: ProjectId) {
      yield* projects.byId(projectId);
      const allocated = yield* allocations.find(projectId);
      return allocated === null
        ? null
        : yield* worktrees
            .byId(allocated)
            .pipe(Effect.catchTag("WorktreeNotFoundError", () => Effect.succeed(null)));
    });
    const start = Effect.fn("ProjectLocalWorktrees.start")(function* (
      projectId: ProjectId,
      ownerUserId: string,
    ) {
      const writer = starts.get(projectId) ?? Semaphore.makeUnsafe(1);
      starts.set(projectId, writer);
      return yield* writer.withPermit(
        Effect.gen(function* () {
          yield* projects.byId(projectId);
          const worktreeId = yield* allocations.reserve(projectId);
          return yield* engine.ensureWorktree(
            projectId,
            { name: null, start: { kind: "local", worktreeId } },
            ownerUserId,
          );
        }),
      );
    });
    return ProjectLocalWorktrees.of({ find, start });
  }),
);
