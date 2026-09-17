import type { FolderId, OrganizationId, ProjectId } from "@mend/domain";
import { Folder, ProjectFolder } from "@mend/domain/workbench";
import { asc, count, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { folders, projectFolders } from "../schema/workbench.ts";
import { isUniqueViolation } from "./unique-violation.ts";

export class FolderNotFoundError extends Schema.TaggedErrorClass<FolderNotFoundError>()(
  "FolderNotFoundError",
  { folderId: Schema.String },
) {}

/** The organization already has a folder with that name. */
export class FolderNameTakenError extends Schema.TaggedErrorClass<FolderNameTakenError>()(
  "FolderNameTakenError",
  { name: Schema.String },
) {}

/** Projects still mount the folder; they must deselect it before it can go. */
export class FolderInUseError extends Schema.TaggedErrorClass<FolderInUseError>()(
  "FolderInUseError",
  { projects: Schema.Int },
) {}

export interface NewFolder {
  readonly id: FolderId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly path: string;
  readonly createdByUserId: string;
}

/** One selected folder as a launch mounts it: the folder, where, and how. */
export interface SelectedFolder {
  readonly folder: Folder;
  readonly selection: ProjectFolder;
}

/**
 * Organization folders and their per-project selection (docs/adr/0003-organizations-and-tenancy.md).
 * The directories themselves live on disk through `FolderStore`.
 */
export class FoldersRepo extends Context.Service<
  FoldersRepo,
  {
    readonly create: (folder: NewFolder) => Effect.Effect<Folder, FolderNameTakenError>;
    readonly byId: (id: FolderId) => Effect.Effect<Folder, FolderNotFoundError>;
    readonly listForOrganization: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<Folder>>;
    readonly remove: (id: FolderId) => Effect.Effect<void, FolderInUseError>;
    readonly listForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<SelectedFolder>>;
    /** Replace the project's selection wholesale; the caller has checked the folders' organization. */
    readonly setForProject: (
      projectId: ProjectId,
      selections: ReadonlyArray<{
        readonly folderId: FolderId;
        readonly name: string;
        readonly readOnly: boolean;
      }>,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/FoldersRepo") {}

const toFolder = (row: typeof folders.$inferSelect): Folder => new Folder(row);

export const FoldersRepoLive: Layer.Layer<FoldersRepo, never, MendDB> = Layer.effect(
  FoldersRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const create = Effect.fn("FoldersRepo.create")(function* (folder: NewFolder) {
      const [row] = yield* db
        .insert(folders)
        .values(folder)
        .returning()
        .pipe(
          Effect.catchTag("EffectDrizzleQueryError", (error) =>
            isUniqueViolation(error)
              ? Effect.fail(new FolderNameTakenError({ name: folder.name }))
              : Effect.die(error),
          ),
        );
      if (row === undefined) return yield* Effect.die("folder insert returned no row");
      return toFolder(row);
    });

    const byId = Effect.fn("FoldersRepo.byId")(function* (id: FolderId) {
      const [row] = yield* db
        .select()
        .from(folders)
        .where(eq(folders.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new FolderNotFoundError({ folderId: id });
      return toFolder(row);
    });

    const listForOrganization = Effect.fn("FoldersRepo.listForOrganization")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* db
        .select()
        .from(folders)
        .where(eq(folders.organizationId, organizationId))
        .orderBy(asc(folders.name))
        .pipe(Effect.orDie);
      return rows.map(toFolder);
    });

    const remove = Effect.fn("FoldersRepo.remove")(function* (id: FolderId) {
      const [usage] = yield* db
        .select({ projects: count() })
        .from(projectFolders)
        .where(eq(projectFolders.folderId, id))
        .pipe(Effect.orDie);
      if ((usage?.projects ?? 0) > 0) {
        return yield* new FolderInUseError({ projects: usage?.projects ?? 0 });
      }
      yield* db.delete(folders).where(eq(folders.id, id)).pipe(Effect.orDie);
    });

    const listForProject = Effect.fn("FoldersRepo.listForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({ folder: folders, selection: projectFolders })
        .from(projectFolders)
        .innerJoin(folders, eq(folders.id, projectFolders.folderId))
        .where(eq(projectFolders.projectId, projectId))
        .orderBy(asc(projectFolders.name))
        .pipe(Effect.orDie);
      return rows.map(
        (row): SelectedFolder => ({
          folder: toFolder(row.folder),
          selection: new ProjectFolder(row.selection),
        }),
      );
    });

    const setForProject = Effect.fn("FoldersRepo.setForProject")(function* (
      projectId: ProjectId,
      selections: ReadonlyArray<{
        readonly folderId: FolderId;
        readonly name: string;
        readonly readOnly: boolean;
      }>,
    ) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .delete(projectFolders)
              .where(eq(projectFolders.projectId, projectId))
              .pipe(Effect.orDie);
            if (selections.length === 0) return;
            yield* tx
              .insert(projectFolders)
              .values(selections.map((selection) => ({ projectId, ...selection })))
              .pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    return { create, byId, listForOrganization, remove, listForProject, setForProject };
  }),
);
