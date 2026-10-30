import { Schema } from "effect";

import { OrganizationId, ProjectId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import {
  canRemoveProject,
  type ProjectTenancy,
  ProjectVisibility,
  type Viewer,
} from "./organization.ts";

export class RemovedProject extends Schema.Class<RemovedProject>("RemovedProject")({
  id: ProjectId,
  name: Schema.String,
  organizationId: OrganizationId,
  visibility: ProjectVisibility,
  createdByUserId: Schema.NullOr(Schema.String),
  removedAt: Timestamp,
  removedByUserId: Schema.NullOr(Schema.String),
  state: Schema.Literals(["removed", "purging", "recovery-required"]),
  rights: Schema.Struct({ restore: Schema.Boolean, purge: Schema.Boolean }),
}) {}

export const projectRetentionRights = (
  project: ProjectTenancy,
  viewer: Viewer,
): { readonly restore: boolean; readonly purge: boolean } => ({
  restore: canRemoveProject(project, viewer),
  purge: canRemoveProject(project, viewer),
});

export const REMOVED_PROJECT_START_REFUSED =
  "Not started. This project was removed. Restore it from Removed projects to work in it.";

/** What a write into a removed project reads, for anyone who can see it in Removed projects. */
export const REMOVED_PROJECT_WORK_REFUSED =
  "This project was removed. Restore it from Removed projects to work in it.";

/** The same, while a purge deletes the project for good. */
export const PURGING_PROJECT_WORK_REFUSED =
  "This project is being purged. Purge it again if the purge stopped partway.";
