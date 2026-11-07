import { CheckpointId } from "@mend/domain";
import { Schema } from "effect";

/** The bounded preparation wait elapsed; preparation continues for the next open. */
export class RawFilePreparing extends Schema.TaggedError<RawFilePreparing>()(
  "RawFilePreparing",
  {},
  { httpApiStatus: 503 },
) {}

/**
 * Nothing was started: every file in Mend's raw cache is being read (`full`), or too many
 * preparations are already in flight (`busy`). A later open starts again.
 */
export class RawFileBusy extends Schema.TaggedError<RawFileBusy>()(
  "RawFileBusy",
  { reason: Schema.Literals(["full", "busy"]) },
  { httpApiStatus: 503 },
) {}

export class RawFileNotFound extends Schema.TaggedError<RawFileNotFound>()(
  "RawFileNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class RawFileTooLarge extends Schema.TaggedError<RawFileTooLarge>()(
  "RawFileTooLarge",
  {},
  { httpApiStatus: 413 },
) {}

/** One file of a worktree, from `GET /api/worktrees/:id/contents?path=`. */
export class WorktreeFile extends Schema.Class<WorktreeFile>("WorktreeFile")({
  path: Schema.String,
  /** The checkpoint it was read at; null for the worktree as it stands. */
  at: Schema.NullOr(CheckpointId),
  /** The file as UTF-8 text, at most 1 MiB of it; null for a binary file. */
  contents: Schema.NullOr(Schema.String),
  /** The whole file's size in bytes. */
  size: Schema.Int,
  /** `contents` holds less than the whole file. */
  truncated: Schema.Boolean,
  binary: Schema.Boolean,
}) {}

/** One line of a worktree that matched, from `GET /api/worktrees/:id/contents?query=`. */
export class WorktreeMatch extends Schema.Class<WorktreeMatch>("WorktreeMatch")({
  path: Schema.String,
  /** From 1. */
  line: Schema.Int,
  /** The line, cut at 2,000 characters. */
  text: Schema.String,
}) {}
