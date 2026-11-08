import { Schema } from "effect";

/** A person's explicit branch operation, never an automatic landing. */
export const WorktreeBranchAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("switch"), refName: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    refName: Schema.String,
    switchRef: Schema.Boolean,
  }),
]);
export type WorktreeBranchAction = typeof WorktreeBranchAction.Type;

/** The requested ref and the branch actually checked out after Git finished. */
export const WorktreeBranchResult = Schema.Struct({
  refName: Schema.String,
  branch: Schema.NullOr(Schema.String),
});
export type WorktreeBranchResult = typeof WorktreeBranchResult.Type;

/** An admission refusal or the reason Git could not finish. */
export class WorktreeGitRefused extends Schema.TaggedError<WorktreeGitRefused>()(
  "WorktreeGitRefused",
  {
    code: Schema.Literals(["forbidden", "busy", "unavailable", "git"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** A ref from the authoritative worktree or its retained Git capture, never the project cache. */
export const WorktreeBranchRef = Schema.Struct({
  name: Schema.String,
  isRemote: Schema.Boolean,
  current: Schema.Boolean,
  upstreamRef: Schema.NullOr(Schema.String),
});
export type WorktreeBranchRef = typeof WorktreeBranchRef.Type;

/** Explicit commit choices; an absent message asks for generation on the caller's login. */
export const WorktreeCommitRequest = Schema.Struct({
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
  filePaths: Schema.optional(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
  writer: Schema.optional(
    Schema.Struct({
      provider: Schema.Literals(["claude", "codex"]),
      model: Schema.optional(Schema.String),
      instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
    }),
  ),
});
export type WorktreeCommitRequest = typeof WorktreeCommitRequest.Type;

/** A commit on the current branch, or a clean worktree, without publication. */
export const WorktreeCommitResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("created"),
    commitSha: Schema.String,
    subject: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("skipped_no_changes") }),
]);
export type WorktreeCommitResult = typeof WorktreeCommitResult.Type;

/** An explicit fast-forward of the current branch's configured upstream. */
export const WorktreePullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: Schema.String,
  upstreamRef: Schema.NullOr(Schema.String),
});
export type WorktreePullResult = typeof WorktreePullResult.Type;

/** Uncommitted paths against HEAD, including staging and untracked paths, for Git's commit picker. */
export const WorktreeGitStatus = Schema.Struct({
  dirty: Schema.Boolean,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, insertions: Schema.Number, deletions: Schema.Number }),
  ),
  insertions: Schema.Number,
  deletions: Schema.Number,
});
export type WorktreeGitStatus = typeof WorktreeGitStatus.Type;
