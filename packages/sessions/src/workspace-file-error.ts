import { Schema } from "effect";

/** A workspace file could not be placed; the message never includes its contents. */
export class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()(
  "WorkspaceFileError",
  { path: Schema.String, message: Schema.String },
) {}
