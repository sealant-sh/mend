import { ProjectMountId, type ProjectId } from "@mend/domain";
import { ProjectMount } from "@mend/domain/workbench";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { projectMounts } from "../schema/workbench.ts";

export class ProjectMountNotFoundError extends Schema.TaggedError<ProjectMountNotFoundError>()(
  "ProjectMountNotFoundError",
  {
    mountId: Schema.String,
  },
) {}

export interface NewProjectMount {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly hostPath: string;
  readonly readOnly: boolean;
}

/**
 * The per-project extra-mount declarations (plan §17, decided 2026-08-01).
 * Rows are declarations only — the host folders belong to the user and are
 * never provisioned or cleaned; the engine binds them at launch.
 */
export class ProjectMountsRepo extends Context.Service<
  ProjectMountsRepo,
  {
    readonly create: (mount: NewProjectMount) => Effect.Effect<ProjectMount>;
    readonly byId: (id: ProjectMountId) => Effect.Effect<ProjectMount, ProjectMountNotFoundError>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<ProjectMount>>;
    readonly remove: (id: ProjectMountId) => Effect.Effect<void>;
  }
>()("@mend/db/ProjectMountsRepo") {}

const toProjectMount = (row: typeof projectMounts.$inferSelect): ProjectMount =>
  new ProjectMount(row);

export const ProjectMountsRepoLive: Layer.Layer<ProjectMountsRepo, never, MendDB> = Layer.effect(
  ProjectMountsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const create = Effect.fn("ProjectMountsRepo.create")(function* (mount: NewProjectMount) {
      const [row] = yield* db
        .insert(projectMounts)
        .values({ id: ProjectMountId.make(crypto.randomUUID()), ...mount })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("project mount insert returned no row");
      return toProjectMount(row);
    });

    const byId = Effect.fn("ProjectMountsRepo.byId")(function* (id: ProjectMountId) {
      const [row] = yield* db
        .select()
        .from(projectMounts)
        .where(eq(projectMounts.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ProjectMountNotFoundError({ mountId: id });
      return toProjectMount(row);
    });

    const listForProject = Effect.fn("ProjectMountsRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(projectMounts)
        .where(eq(projectMounts.projectId, projectId))
        .orderBy(asc(projectMounts.name))
        .pipe(Effect.orDie);
      return rows.map(toProjectMount);
    });

    const remove = Effect.fn("ProjectMountsRepo.remove")(function* (id: ProjectMountId) {
      yield* db.delete(projectMounts).where(eq(projectMounts.id, id)).pipe(Effect.orDie);
    });

    return { create, byId, listForProject, remove };
  }),
);
