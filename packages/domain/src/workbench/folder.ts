import { Schema } from "effect";

import { FolderId, OrganizationId, ProjectId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A directory Mend keeps for an organization (docs/adr/0003-organizations-and-tenancy.md): shared
 * reading material, fixtures, anything an agent should see beside the worktree. It replaces host
 * mounts, which hand an arbitrary path on the machine to whoever can edit a project. Owners create
 * folders and put files in them; projects select which ones their sessions mount, read-only by
 * default, at `/workspace/home/<name>`.
 */
export class Folder extends Schema.Class<Folder>("Folder")({
  id: FolderId,
  organizationId: OrganizationId,
  /** Short name, unique within the organization; the default mount directory name. */
  name: Schema.String,
  /** Absolute path of the directory inside the store: `_organizations/<org>/folders/<id>`. */
  path: Schema.String,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/**
 * Where a folder reaches a session: a bind mount on a co-located install, and the path sealantd
 * lays the folder's archive down at in a captured workspace (`capture-sources.ts`).
 */
export const folderMountPath = (name: string): string => `/workspace/home/${name}`;

/** One project's choice of a folder: where it mounts and whether sessions may write to it. */
export class ProjectFolder extends Schema.Class<ProjectFolder>("ProjectFolder")({
  projectId: ProjectId,
  folderId: FolderId,
  /** Mount directory under `/workspace/home/`. */
  name: Schema.String,
  readOnly: Schema.Boolean,
  createdAt: Timestamp,
}) {}

/** A file in a folder, as a listing shows it. */
export class FolderFile extends Schema.Class<FolderFile>("FolderFile")({
  path: Schema.String,
  bytes: Schema.Int,
}) {}

/** Upload and listing limits: folders carry reading material, not build artifacts. */
export const FOLDER_MAX_FILE_BYTES = 1024 * 1024;
export const FOLDER_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const FOLDER_MAX_LISTED_FILES = 5000;
