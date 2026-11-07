import { ProjectId } from "@mend/domain";
import { Schema } from "effect";

import { WorktreeFile, WorktreeMatch } from "./file-reads.ts";

/** Text or matching lines from a project's default branch, without a session. */
export class ProjectContents extends Schema.Class<ProjectContents>("ProjectContents")({
  projectId: ProjectId,
  file: Schema.NullOr(WorktreeFile),
  search: Schema.NullOr(
    Schema.Struct({ matches: Schema.Array(WorktreeMatch), truncated: Schema.Boolean }),
  ),
}) {}

/** Exactly one of path and query is required by the handler. */
export const projectContentsQuery = {
  path: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  caseSensitive: Schema.optional(Schema.String),
  wholeWord: Schema.optional(Schema.String),
  regex: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
};
