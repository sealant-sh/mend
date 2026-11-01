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
  handoff: Schema.NullOr(WorktreeHandoff).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * The change's owner (docs/adr/0007-landing.md, "Who lands"): the owner of the worktree's first
   * session, recorded once when that session starts and kept when it is deleted. Null when the
   * worktree has had no session, or its first session had no owner; a server from before 0.37 never
   * sends it.
   */
  changeOwnerUserId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Whether Mend's history proves `changeOwnerUserId` was the first session's owner. A worktree
   * from before 0.37 may have had a first session that was deleted before Mend kept the owner: its
   * owner is the earliest session's that still stood then, as landing has read it, but unproven.
   */
  changeOwnerProven: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /** Default resource visibility captured when this worktree was created. */
  usesProjectResources: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.withConstructorDefault(Effect.succeed(true)),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}
