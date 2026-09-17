import { FolderId, ProjectId } from "@mend/domain";
import { Folder, FolderFile } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * Organization folders (docs/adr/0003-organizations-and-tenancy.md): Mend-managed directories that
 * replace host mounts. Members list folders and read their file listings; owners create and remove
 * folders and change their contents; whoever manages a project chooses which folders it mounts.
 * Anything the caller may not reach answers 404.
 */

/** A folder request the rules refuse; the message says which rule. */
export class FolderRejected extends Schema.TaggedErrorClass<FolderRejected>()(
  "FolderRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class CreateFolderRequest extends Schema.Class<CreateFolderRequest>("CreateFolderRequest")({
  name: Schema.String,
}) {}

export class FolderUploadFile extends Schema.Class<FolderUploadFile>("FolderUploadFile")({
  /** Folder-relative, forward slashes. */
  path: Schema.String,
  contentsBase64: Schema.String,
}) {}

export class FolderUploadRequest extends Schema.Class<FolderUploadRequest>("FolderUploadRequest")({
  files: Schema.Array(FolderUploadFile),
  /** False empties the folder before writing: the upload becomes its whole contents. */
  merge: Schema.Boolean,
}) {}

export class FolderListing extends Schema.Class<FolderListing>("FolderListing")({
  files: Schema.Array(FolderFile),
  truncated: Schema.Boolean,
}) {}

export class ProjectFolderSelection extends Schema.Class<ProjectFolderSelection>(
  "ProjectFolderSelection",
)({
  folderId: FolderId,
  /** Mount directory under `/workspace/home/`. */
  name: Schema.String,
  readOnly: Schema.Boolean,
}) {}

export class ProjectFolderView extends Schema.Class<ProjectFolderView>("ProjectFolderView")({
  folder: Folder,
  name: Schema.String,
  readOnly: Schema.Boolean,
}) {}

export class SetProjectFoldersRequest extends Schema.Class<SetProjectFoldersRequest>(
  "SetProjectFoldersRequest",
)({
  selections: Schema.Array(ProjectFolderSelection),
}) {}

export const foldersGroup = HttpApiGroup.make("folders")
  .add(HttpApiEndpoint.get("list", "/organization/folders", { success: Schema.Array(Folder) }))
  .add(
    HttpApiEndpoint.post("create", "/organization/folders", {
      payload: CreateFolderRequest,
      success: Folder,
      error: [NotFound, FolderRejected],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/organization/folders/:id", {
      params: { id: FolderId },
      error: [NotFound, FolderRejected],
    }),
  )
  .add(
    HttpApiEndpoint.get("files", "/organization/folders/:id/files", {
      params: { id: FolderId },
      success: FolderListing,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("upload", "/organization/folders/:id/files", {
      params: { id: FolderId },
      payload: FolderUploadRequest,
      success: FolderListing,
      error: [NotFound, FolderRejected],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteFile", "/organization/folders/:id/files", {
      params: { id: FolderId },
      query: { path: Schema.String },
      error: [NotFound, FolderRejected],
    }),
  )
  .add(
    HttpApiEndpoint.get("forProject", "/projects/:id/folders", {
      params: { id: ProjectId },
      success: Schema.Array(ProjectFolderView),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("selectForProject", "/projects/:id/folders", {
      params: { id: ProjectId },
      payload: SetProjectFoldersRequest,
      success: Schema.Array(ProjectFolderView),
      error: [NotFound, FolderRejected],
    }),
  )
  .middleware(AuthMiddleware);
