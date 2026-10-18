import { ProjectId, SkillId } from "@mend/domain";
import { Skill, SkillFile, SkillScope, SkillWithFiles } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/** The bundle failed validation or collided with the library's caps; the message says how. */
export class SkillRejected extends Schema.TaggedError<SkillRejected>()(
  "SkillRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Someone else saved this skill first; re-read and reapply. */
export class SkillStaleWrite extends Schema.TaggedError<SkillStaleWrite>()(
  "SkillStaleWrite",
  { skillId: Schema.String, currentRevision: Schema.Int },
  { httpApiStatus: 409 },
) {}

/**
 * Where a write lands: the caller's own library, or a project's. Flat rather
 * than a union so the wire shape stays obvious; the server rejects a project
 * write without a projectId.
 */
const scopeFields = {
  scope: SkillScope,
  projectId: Schema.NullOr(ProjectId),
};

export class SkillCreateRequest extends Schema.Class<SkillCreateRequest>("SkillCreateRequest")({
  ...scopeFields,
  name: Schema.String,
  description: Schema.String,
  files: Schema.Array(SkillFile),
}) {}

export class SkillUpdateRequest extends Schema.Class<SkillUpdateRequest>("SkillUpdateRequest")({
  name: Schema.String,
  description: Schema.String,
  files: Schema.Array(SkillFile),
  expectedRevision: Schema.Int,
}) {}

/** One bundle inside a sync upload. */
export class SkillUpload extends Schema.Class<SkillUpload>("SkillUpload")({
  name: Schema.String,
  description: Schema.String,
  files: Schema.Array(SkillFile),
}) {}

/**
 * The CLI's bulk upload (`mend skills push`): the scanned library as the
 * intent. `prune` removes server-side skills the upload no longer carries.
 */
export class SkillsSyncRequest extends Schema.Class<SkillsSyncRequest>("SkillsSyncRequest")({
  ...scopeFields,
  skills: Schema.Array(SkillUpload),
  prune: Schema.Boolean,
}) {}

export class SkillsSyncReport extends Schema.Class<SkillsSyncReport>("SkillsSyncReport")({
  created: Schema.Array(Schema.String),
  updated: Schema.Array(Schema.String),
  unchanged: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
}) {}

/**
 * Skill libraries: the current user's (identity — every route acts as the
 * authenticated account, like dotfiles) and each project's. Bundles
 * materialize into every new session's harness home at launch.
 */
export const skillsGroup = HttpApiGroup.make("skills")
  .add(HttpApiEndpoint.get("list", "/skills", { success: Schema.Array(Skill) }))
  .add(
    HttpApiEndpoint.get("forProject", "/projects/:id/skills", {
      params: { id: ProjectId },
      success: Schema.Array(Skill),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/skills/:skillId", {
      params: { skillId: SkillId },
      success: SkillWithFiles,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/skills", {
      payload: SkillCreateRequest,
      success: SkillWithFiles,
      error: [NotFound, SkillRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/skills/:skillId", {
      params: { skillId: SkillId },
      payload: SkillUpdateRequest,
      success: SkillWithFiles,
      error: [NotFound, SkillRejected, SkillStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/skills/:skillId", {
      params: { skillId: SkillId },
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("sync", "/skills/sync", {
      payload: SkillsSyncRequest,
      success: SkillsSyncReport,
      error: [NotFound, SkillRejected],
    }),
  )
  .middleware(AuthMiddleware);
