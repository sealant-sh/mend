import { Effect, Schema } from "effect";

import { ProjectId, Sha, WorktreeId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { WorktreeHandoff } from "./handoff.ts";

export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * A worktree's name: the session's identity in every list, and the tail of
 * its branch (`mend/<name>`).
 */
export const WorktreeName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      WORKTREE_NAME_PATTERN.test(value)
        ? undefined
        : "a short lowercase name like `fix-auth` — letters, digits, `.`, `_`, `-`",
    ),
  ),
);
export type WorktreeName = typeof WorktreeName.Type;

/**
 * The durable container (plan §5.5/§5.6): one named git worktree in the
 * project's central store, owning the change, its checkpoints, and their
 * review. Sessions are conversations inside it — many over its life, several
 * live at once. It outlives every one of them; removal is a separate explicit
 * act, refused while any session is live.
 */
export class Worktree extends Schema.Class<Worktree>("Worktree")({
  id: WorktreeId,
  projectId: ProjectId,
  /** Display identity — the name-first flow's answer; renameable; unique per project. */
  name: Schema.String,
  /**
   * Directory name under the store's `worktrees/` parent. Immutable: workspace
   * bind mounts and recorded paths point here, so identity renames touch only
   * `name` and `branch`, never this.
   */
  directory: Schema.String,
  /** The branch the worktree is on: `mend/<name>`, or `mend/wt/<id>` before naming. */
  branch: Schema.String,
  /** The comparison base — where the worktree branched from. */
  baseSha: Sha,
  /**
   * The base as the user named it — a branch, tag, or sha; the project's default branch when
   * nothing was chosen. Null only for rows migrated from sessions provisioned before the
   * session-level column existed.
   */
  baseRef: Schema.NullOr(Schema.String),
  /**
   * Where a handed-off worktree came from (`mend handoff`): the machine, the local branch, the
   * cut time and the snapshot its capture 0 was laid down from. Null for a worktree that
   * started from a base, and for one a server from before handoffs lists.
   */
  handoff: Schema.NullOr(WorktreeHandoff).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}
