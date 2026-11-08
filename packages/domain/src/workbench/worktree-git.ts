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
