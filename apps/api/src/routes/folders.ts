import * as path from "node:path";

import {
  CurrentUser,
  FolderListing,
  FolderRejected,
  MendApi,
  NotFound,
  ProjectFolderView,
} from "@mend/api-contracts";
import { AuditEventsRepo, FoldersRepo, ProjectMountsRepo } from "@mend/db";
import { FolderId, type ProjectId } from "@mend/domain";
import { FOLDER_MAX_LISTED_FILES, type Folder } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { FolderStore, folderDirectory, StoreConfig } from "@mend/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";

/** Folder and mount names become directory names inside the workspace. */
const FOLDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const nameIssue = (name: string, what: string): FolderRejected | null =>
  FOLDER_NAME.test(name)
    ? null
    : new FolderRejected({
        message: `"${name}" is not a usable ${what} name (lowercase letters, digits, ".", "_", "-").`,
      });

/** A folder of the caller's organization; `NotFound` for a folder elsewhere or missing. */
const reachableFolder = (id: FolderId, owner: boolean) =>
  Effect.gen(function* () {
    const access = yield* ProjectAccess;
    const viewer = owner ? yield* access.requireOwner(id) : yield* access.viewer();
    if (viewer === null) return yield* new NotFound({ id });
    const folders = yield* FoldersRepo;
    const folder = yield* folders.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
    if (folder.organizationId !== viewer.organizationId) return yield* new NotFound({ id });
    return folder;
  });

const directoryOf = (folder: Folder) => folderDirectory(folder.organizationId, folder.id);

const projectFolderViews = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const folders = yield* FoldersRepo;
    return (yield* folders.listForProject(projectId)).map(
      ({ folder, selection }) =>
        new ProjectFolderView({ folder, name: selection.name, readOnly: selection.readOnly }),
    );
  });

/**
 * Organization folders (docs/adr/0003-organizations-and-tenancy.md). Members list them and read
 * their listings; owners create, fill and remove them; whoever manages a project picks the folders
 * its sessions mount. Every check runs before the disk or the database is touched.
 */
export const FoldersGroupLive = HttpApiBuilder.group(MendApi, "folders", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const viewer = yield* (yield* ProjectAccess).viewer();
        if (viewer === null) return [];
        const folders = yield* FoldersRepo;
        return yield* folders.listForOrganization(viewer.organizationId);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const viewer = yield* (yield* ProjectAccess).requireOwner("folders");
        const issue = nameIssue(payload.name, "folder");
        if (issue !== null) return yield* issue;
        const caller = yield* CurrentUser;
        const folders = yield* FoldersRepo;
        const store = yield* FolderStore;
        const config = yield* StoreConfig;
        const id = FolderId.make(crypto.randomUUID());
        const directory = folderDirectory(viewer.organizationId, id);
        yield* store
          .create(directory)
          .pipe(Effect.mapError((error) => new FolderRejected({ message: error.message })));
        const created = yield* folders
          .create({
            id,
            organizationId: viewer.organizationId,
            name: payload.name,
            path: path.join(config.root, directory),
            createdByUserId: caller.user.id,
          })
          .pipe(
            Effect.catchTag("FolderNameTakenError", () =>
              store.remove(directory).pipe(
                Effect.andThen(
                  Effect.fail(
                    new FolderRejected({
                      message: `A folder named "${payload.name}" already exists.`,
                    }),
                  ),
                ),
              ),
            ),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: viewer.organizationId,
          actorUserId: caller.user.id,
          action: "folder.created",
          subjectType: "folder",
          subjectId: created.id,
          data: { name: created.name },
        });
        return created;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const folder = yield* reachableFolder(params.id, true);
        const folders = yield* FoldersRepo;
        const store = yield* FolderStore;
        yield* folders.remove(folder.id).pipe(
          Effect.catchTag("FolderInUseError", (error) =>
            Effect.fail(
              new FolderRejected({
                message: `${error.projects === 1 ? "A project mounts" : `${error.projects} projects mount`} this folder. Deselect it there first.`,
              }),
            ),
          ),
        );
        yield* store.remove(directoryOf(folder));
        yield* (yield* AuditEventsRepo).record({
          organizationId: folder.organizationId,
          actorUserId: (yield* CurrentUser).user.id,
          action: "folder.removed",
          subjectType: "folder",
          subjectId: folder.id,
          data: { name: folder.name },
        });
      }),
    )
    .handle("files", ({ params }) =>
      Effect.gen(function* () {
        const folder = yield* reachableFolder(params.id, false);
        const store = yield* FolderStore;
        const listing = yield* store
          .list(directoryOf(folder), FOLDER_MAX_LISTED_FILES)
          .pipe(Effect.orDie);
        return new FolderListing(listing);
      }),
    )
    .handle("upload", ({ params, payload }) =>
      Effect.gen(function* () {
        const folder = yield* reachableFolder(params.id, true);
        const store = yield* FolderStore;
        yield* store
          .write(directoryOf(folder), payload.files, { merge: payload.merge })
          .pipe(Effect.mapError((error) => new FolderRejected({ message: error.message })));
        const listing = yield* store
          .list(directoryOf(folder), FOLDER_MAX_LISTED_FILES)
          .pipe(Effect.orDie);
        return new FolderListing(listing);
      }),
    )
    .handle("deleteFile", ({ params, query }) =>
      Effect.gen(function* () {
        const folder = yield* reachableFolder(params.id, true);
        const store = yield* FolderStore;
        yield* store
          .deleteFile(directoryOf(folder), query.path)
          .pipe(Effect.mapError((error) => new FolderRejected({ message: error.message })));
      }),
    )
    .handle("forProject", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.id);
        return yield* projectFolderViews(params.id);
      }),
    )
    .handle("selectForProject", ({ params, payload }) =>
      Effect.gen(function* () {
        const project = yield* (yield* ProjectAccess).manageProject(params.id);
        const folders = yield* FoldersRepo;
        // Only the project's own organization's folders: any other id is not found.
        for (const selection of payload.selections) {
          const folder = yield* folders
            .byId(selection.folderId)
            .pipe(Effect.mapError(() => new NotFound({ id: selection.folderId })));
          if (folder.organizationId !== project.organizationId) {
            return yield* new NotFound({ id: selection.folderId });
          }
          const issue = nameIssue(selection.name, "mount");
          if (issue !== null) return yield* issue;
        }
        const names = payload.selections.map((selection) => selection.name);
        const mounts = yield* ProjectMountsRepo;
        const taken = new Set<string>(
          (yield* mounts.listForProject(params.id)).map((mount) => mount.name),
        );
        const clash = names.find((name, index) => names.indexOf(name) !== index || taken.has(name));
        if (clash !== undefined) {
          return yield* new FolderRejected({
            message: `Two mounts would share /workspace/home/${clash}. Pick another name.`,
          });
        }
        yield* folders.setForProject(params.id, payload.selections);
        yield* (yield* SessionEngine).reconcileHotSessions(params.id);
        return yield* projectFolderViews(params.id);
      }),
    ),
);
