import { PgClient } from "@effect/sql-pg";
import type { ProjectId } from "@mend/domain";
import { ServiceRecipe } from "@mend/domain/workbench";
import { and, asc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { projectServiceRecipes } from "../schema/workbench.ts";

/**
 * Project-level Service recipes (docs/SESSION-SERVICES.md): the web-editable
 * twin of mend.toml. The file is project truth that travels with the repo;
 * these rows are THIS machine's additions. The union (engine-side) refuses
 * name collisions rather than resolving them — the file wins.
 */

export class RecipeNameTakenError extends Schema.TaggedError<RecipeNameTakenError>()(
  "RecipeNameTakenError",
  {
    name: Schema.String,
  },
) {}

export interface NewProjectServiceRecipe {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly command: string | null;
  readonly port: number;
  readonly protocol: "tcp" | "udp";
  readonly browserScheme: "http" | "https" | null;
}

export class ProjectServiceRecipesRepo extends Context.Service<
  ProjectServiceRecipesRepo,
  {
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<ServiceRecipe>>;
    readonly create: (
      input: NewProjectServiceRecipe,
    ) => Effect.Effect<ServiceRecipe, RecipeNameTakenError>;
    readonly remove: (projectId: ProjectId, name: string) => Effect.Effect<void>;
  }
>()("@mend/db/ProjectServiceRecipesRepo") {}

const toRecipe = (row: {
  readonly name: string;
  readonly command: string | null;
  readonly port: number;
  readonly protocol: "tcp" | "udp";
  readonly browserScheme: "http" | "https" | null;
}): ServiceRecipe =>
  new ServiceRecipe({
    name: row.name,
    command: row.command,
    port: row.port,
    protocol: row.protocol,
    browserScheme: row.browserScheme,
    source: "project",
    shadowedBy: null,
  });

export const ProjectServiceRecipesRepoLive: Layer.Layer<
  ProjectServiceRecipesRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ProjectServiceRecipesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const notify = (projectId: ProjectId) =>
      notifyEvent(pg, { type: "project", projectId }).pipe(Effect.ignore);

    const listForProject = Effect.fn("ProjectServiceRecipesRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(projectServiceRecipes)
        .where(eq(projectServiceRecipes.projectId, projectId))
        .orderBy(asc(projectServiceRecipes.name))
        .pipe(Effect.orDie);
      return rows.map(toRecipe);
    });

    const create = Effect.fn("ProjectServiceRecipesRepo.create")(function* (
      input: NewProjectServiceRecipe,
    ) {
      const inserted = yield* db
        .insert(projectServiceRecipes)
        .values(input)
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.orDie);
      const row = inserted[0];
      if (row === undefined) {
        return yield* new RecipeNameTakenError({ name: input.name });
      }
      yield* notify(input.projectId);
      return toRecipe(row);
    });

    const remove = Effect.fn("ProjectServiceRecipesRepo.remove")(function* (
      projectId: ProjectId,
      name: string,
    ) {
      yield* db
        .delete(projectServiceRecipes)
        .where(
          and(eq(projectServiceRecipes.projectId, projectId), eq(projectServiceRecipes.name, name)),
        )
        .pipe(Effect.orDie);
      yield* notify(projectId);
    });

    return { listForProject, create, remove };
  }),
);
