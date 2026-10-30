import { ProjectLinkId, type ProjectId } from "@mend/domain";
import { ProjectLink } from "@mend/domain/workbench";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { projects } from "../schema/workbench.ts";
import { projectLinks } from "../schema/workbench.ts";
import { projectListed } from "./projects.ts";

export class ProjectLinkNotFoundError extends Schema.TaggedError<ProjectLinkNotFoundError>()(
  "ProjectLinkNotFoundError",
  {
    linkId: Schema.String,
  },
) {}

export interface NewProjectLink {
  readonly projectId: ProjectId;
  readonly linkedProjectId: ProjectId;
  readonly name: string;
  readonly worktreeName: string;
}

/**
 * The per-project linked-project declarations (ADR-0001). Rows are
 * declarations only; the engine mounts the linked project's worktrees root and
 * binds the named worktree at launch.
 */
export class ProjectLinksRepo extends Context.Service<
  ProjectLinksRepo,
  {
    readonly create: (link: NewProjectLink) => Effect.Effect<ProjectLink>;
    readonly byId: (id: ProjectLinkId) => Effect.Effect<ProjectLink, ProjectLinkNotFoundError>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<ProjectLink>>;
    readonly remove: (id: ProjectLinkId) => Effect.Effect<void>;
  }
>()("@mend/db/ProjectLinksRepo") {}

const toProjectLink = (row: typeof projectLinks.$inferSelect): ProjectLink => new ProjectLink(row);

export const ProjectLinksRepoLive: Layer.Layer<ProjectLinksRepo, never, MendDB> = Layer.effect(
  ProjectLinksRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const listedTarget = inArray(
      projectLinks.linkedProjectId,
      db.select({ id: projects.id }).from(projects).where(projectListed),
    );

    const create = Effect.fn("ProjectLinksRepo.create")(function* (link: NewProjectLink) {
      const [row] = yield* db
        .insert(projectLinks)
        .values({ id: ProjectLinkId.make(crypto.randomUUID()), ...link })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("project link insert returned no row");
      return toProjectLink(row);
    });

    const byId = Effect.fn("ProjectLinksRepo.byId")(function* (id: ProjectLinkId) {
      const [row] = yield* db
        .select()
        .from(projectLinks)
        .where(and(listedTarget, eq(projectLinks.id, id)))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new ProjectLinkNotFoundError({ linkId: id });
      return toProjectLink(row);
    });

    const listForProject = Effect.fn("ProjectLinksRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(projectLinks)
        .where(and(listedTarget, eq(projectLinks.projectId, projectId)))
        .orderBy(asc(projectLinks.name))
        .pipe(Effect.orDie);
      return rows.map(toProjectLink);
    });

    const remove = Effect.fn("ProjectLinksRepo.remove")(function* (id: ProjectLinkId) {
      yield* db.delete(projectLinks).where(eq(projectLinks.id, id)).pipe(Effect.orDie);
    });

    return { create, byId, listForProject, remove };
  }),
);
