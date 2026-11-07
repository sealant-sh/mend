import { PgClient } from "@effect/sql-pg";
import { type ProjectId, WorktreeId } from "@mend/domain";
import { Context, Effect, Layer, Schema } from "effect";

const Allocation = Schema.Struct({ worktreeId: WorktreeId });
const decodeAllocation = Schema.decodeUnknownEffect(Allocation);

/** One durable worktree identity per project, reserved before any checkout is created. */
export class ProjectLocalWorktreesRepo extends Context.Service<
  ProjectLocalWorktreesRepo,
  {
    /** Lookup has no writes and does not reserve a worktree. */
    readonly find: (projectId: ProjectId) => Effect.Effect<WorktreeId | null>;
    /** Concurrent reservations return the same identity. */
    readonly reserve: (projectId: ProjectId) => Effect.Effect<WorktreeId>;
  }
>()("@mend/db/ProjectLocalWorktreesRepo") {}

/** PostgreSQL's project primary key makes the allocation common to all API processes. */
export const ProjectLocalWorktreesRepoLive: Layer.Layer<
  ProjectLocalWorktreesRepo,
  never,
  PgClient.PgClient
> = Layer.effect(
  ProjectLocalWorktreesRepo,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const find = Effect.fn("ProjectLocalWorktreesRepo.find")(function* (projectId: ProjectId) {
      const [row] =
        yield* sql`SELECT worktree_id FROM project_local_worktrees WHERE project_id = ${projectId}`.pipe(
          Effect.orDie,
        );
      return row === undefined
        ? null
        : (yield* decodeAllocation(row).pipe(Effect.orDie)).worktreeId;
    });
    const reserve = Effect.fn("ProjectLocalWorktreesRepo.reserve")(function* (
      projectId: ProjectId,
    ) {
      const candidate = WorktreeId.make(crypto.randomUUID());
      const [row] = yield* sql`
        INSERT INTO project_local_worktrees (project_id, worktree_id)
        VALUES (${projectId}, ${candidate})
        ON CONFLICT (project_id) DO NOTHING RETURNING worktree_id`.pipe(Effect.orDie);
      if (row !== undefined) return (yield* decodeAllocation(row).pipe(Effect.orDie)).worktreeId;
      const existing = yield* find(projectId);
      if (existing === null)
        return yield* Effect.die("Local allocation disappeared after reservation");
      return existing;
    });
    return ProjectLocalWorktreesRepo.of({ find, reserve });
  }),
);

/** An isolated allocation store for assemblies that do not use PostgreSQL. */
export const ProjectLocalWorktreesRepoMemory: Layer.Layer<ProjectLocalWorktreesRepo> = Layer.sync(
  ProjectLocalWorktreesRepo,
  () => {
    const allocations = new Map<ProjectId, WorktreeId>();
    return ProjectLocalWorktreesRepo.of({
      find: (projectId) => Effect.sync(() => allocations.get(projectId) ?? null),
      reserve: (projectId) =>
        Effect.sync(() => {
          const existing = allocations.get(projectId);
          if (existing !== undefined) return existing;
          const id = WorktreeId.make(crypto.randomUUID());
          allocations.set(projectId, id);
          return id;
        }),
    });
  },
);
