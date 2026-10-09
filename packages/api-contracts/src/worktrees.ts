import { CheckpointId, ProjectId, WorktreeId } from "@mend/domain";
import {
  AgentLaunchMode,
  Change as SessionChange,
  Checkpoint,
  PreReleaseMemory,
  Session,
  Worktree,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { CheckpointRequest, WorktreeName } from "./project-environment.ts";
import {
  ObservationStamp,
  RemovalReport,
  SessionAnnotation,
  StoreFailure,
  WorktreeAnnotation,
} from "./workbench-views.ts";

// ─── The worktree container (plan §5.5/§5.6) ────────────────────────────────
// The durable named place: it owns the change, the checkpoint chain, and the
// review; sessions are conversations inside it. Removal is its own explicit
// verb, refused while any conversation is live.

export class WorktreeNotFound extends Schema.TaggedErrorClass<WorktreeNotFound>()(
  "WorktreeNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Removing a worktree with live conversations is refused — stop them first. */
export class WorktreeActive extends Schema.TaggedErrorClass<WorktreeActive>()(
  "WorktreeActive",
  { id: Schema.String, liveSessions: Schema.Int },
  { httpApiStatus: 409 },
) {}

/** The name already names a worktree here. POST /worktrees never joins; joining is the sessions verb. */
export class WorktreeNameTaken extends Schema.TaggedErrorClass<WorktreeNameTaken>()(
  "WorktreeNameTaken",
  { projectId: Schema.String, name: Schema.String },
  { httpApiStatus: 409 },
) {}

/** One file of a checkpoint range, as git counts it (`DiffFileFact` in @mend/store). */
export class WorktreeRangeFile extends Schema.Class<WorktreeRangeFile>("WorktreeRangeFile")({
  oldPath: Schema.NullOr(Schema.String),
  newPath: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
    "unmerged",
    "unknown",
  ]),
  additions: Schema.Int,
  deletions: Schema.Int,
  binary: Schema.Boolean,
}) {}

/**
 * A slice of a worktree's checkpoint chain, rendered: from `from` (or, with none, the worktree's
 * base) to `to`. Both ends are immutable commits, so the slice never moves; what it was read from
 * is in `observation`, as for a change's diff.
 *
 * Bounded: `files` lists every file of the slice (or the one `path` asked for), while `diff`
 * carries the patches of at most 200 of them within 8 MiB, rendered whole, in `files`' order.
 * `truncated` says some are not in `diff`, and `omitted` names them; each can be asked for alone
 * with `path`. A file whose own patch passes the budget stays omitted.
 */
export class WorktreeRangeDiff extends Schema.Class<WorktreeRangeDiff>("WorktreeRangeDiff")({
  worktreeId: WorktreeId,
  /** Null when the slice starts at the worktree's base. */
  from: Schema.NullOr(Checkpoint),
  to: Checkpoint,
  /** The commit the slice starts at: `from`'s, else the worktree's base. */
  fromSha: Schema.String,
  diff: Schema.String,
  files: Schema.Array(WorktreeRangeFile),
  /**
   * Not every file has its patch in `diff`: some of `files` are `omitted`, or the slice has more
   * files than `files` lists (`listingCut`).
   */
  truncated: Schema.Boolean,
  /** The files of `files` with no patch in `diff`, by path (the new path, else the old). */
  omitted: Schema.Array(Schema.String),
  /**
   * The slice has more files than `files` lists: Mend listed its first files within its listing
   * budget or deadline. Ask for one by `path` to get it whatever its place.
   */
  listingCut: Schema.Boolean,
  observation: Schema.optionalKey(ObservationStamp),
}) {}

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
  text: Schema.String,
}) {}

/**
 * A read of a worktree's files: one file (`path`), or the lines matching a search (`query`), the
 * worktree as it stands, untracked files included and ignored ones not. Exactly one is answered.
 */
export class WorktreeContents extends Schema.Class<WorktreeContents>("WorktreeContents")({
  worktreeId: WorktreeId,
  file: Schema.NullOr(WorktreeFile),
  search: Schema.NullOr(
    Schema.Struct({ matches: Schema.Array(WorktreeMatch), truncated: Schema.Boolean }),
  ),
  observation: Schema.optionalKey(ObservationStamp),
}) {}

/** Provisioning the container without a conversation; joining happens via sessions. */
export class NewWorktree extends Schema.Class<NewWorktree>("NewWorktree")({
  /** Null derives an anonymous identity; a given name must be unused (409 otherwise). */
  name: Schema.NullOr(WorktreeName).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Branch or sha to base on; null = the project's default branch. */
  base: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

/** A new conversation inside an existing worktree; launching is separate, as with sessions. */
export class NewWorktreeSession extends Schema.Class<NewWorktreeSession>("NewWorktreeSession")({
  harness: Schema.String,
  /** Intended agent launch shape; omitted keeps the PTY default. */
  mode: Schema.optional(AgentLaunchMode),
  label: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * This session's own "Land when a turn completes" (the composer's override,
   * docs/adr/0007-landing.md). Null (and older clients, which omit the key) follows the project.
   */
  autoLand: Schema.NullOr(Schema.Boolean).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

export class WorktreeListing extends Schema.Class<WorktreeListing>("WorktreeListing")({
  worktrees: Schema.Array(Worktree),
  annotations: Schema.Array(WorktreeAnnotation),
}) {}

export class WorktreeDetail extends Schema.Class<WorktreeDetail>("WorktreeDetail")({
  worktree: Worktree,
  change: Schema.NullOr(SessionChange),
  /** The worktree's full chain, ordinal order — any two define a slice. */
  checkpoints: Schema.Array(Checkpoint),
  /** Every conversation, newest first. */
  sessions: Schema.Array(Session),
  /** Per-session facts so clients fold status without N detail calls. */
  sessionAnnotations: Schema.Array(SessionAnnotation),
  /**
   * What the migration of the worktree's shared home from before per-person homes did with its
   * memory (docs/adr/0016, decision 14), including what it credited to nobody ("memory from
   * before 0.36, not credited"). Null when it never ran; older servers omit it.
   */
  preReleaseMemory: Schema.NullOr(PreReleaseMemory).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

export const worktreesGroup = HttpApiGroup.make("worktrees")
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/worktrees", {
      params: { id: ProjectId },
      payload: NewWorktree,
      success: Worktree,
      error: [NotFound, WorktreeNameTaken, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/worktrees", {
      params: { id: ProjectId },
      success: WorktreeListing,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/worktrees/:id", {
      params: { id: WorktreeId },
      success: WorktreeDetail,
      error: WorktreeNotFound,
    }),
  )
  .add(
    // The one explicit destructive act: conversations, change, chain, and
    // review artifacts go with the directory. Refused while any conversation
    // is live, and while a change not on origin stands (docs/adr/0007-landing.md,
    // "Worktree removal") unless `force=true`.
    HttpApiEndpoint.delete("remove", "/worktrees/:id", {
      params: { id: WorktreeId },
      query: { force: Schema.optional(Schema.String) },
      success: RemovalReport,
      error: [WorktreeNotFound, WorktreeActive, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("createSession", "/worktrees/:id/sessions", {
      params: { id: WorktreeId },
      payload: NewWorktreeSession,
      success: Session,
      error: [WorktreeNotFound, StoreFailure],
    }),
  )
  .add(
    // A read: a slice of the worktree's checkpoint chain, for clients that show one turn's work
    // (the t3code gateway, ADR 0012 phase 3). Visible to whoever sees the worktree.
    HttpApiEndpoint.get("diff", "/worktrees/:id/diff", {
      params: { id: WorktreeId },
      query: {
        from: Schema.optional(CheckpointId),
        to: CheckpointId,
        whitespace: Schema.optional(Schema.Literal("ignore")),
        /** One file of the slice, by its new or old path: its patch alone. */
        path: Schema.optional(Schema.String),
      },
      success: WorktreeRangeDiff,
      error: [WorktreeNotFound, NotFound, StoreFailure],
    }),
  )
  .add(
    // A read of the worktree's files: one file, as it stands or at a checkpoint, or a search of
    // its lines. Visible to whoever sees the worktree (the t3code gateway, ADR 0012 phase 3).
    HttpApiEndpoint.get("contents", "/worktrees/:id/contents", {
      params: { id: WorktreeId },
      query: {
        path: Schema.optional(Schema.String),
        at: Schema.optional(CheckpointId),
        query: Schema.optional(Schema.String),
        caseSensitive: Schema.optional(Schema.Literals(["true", "false"])),
        wholeWord: Schema.optional(Schema.Literals(["true", "false"])),
        regex: Schema.optional(Schema.Literals(["true", "false"])),
        limit: Schema.optional(Schema.String),
      },
      success: WorktreeContents,
      error: [WorktreeNotFound, NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("checkpoint", "/worktrees/:id/checkpoints", {
      params: { id: WorktreeId },
      payload: CheckpointRequest,
      success: Checkpoint,
      error: [WorktreeNotFound, StoreFailure],
    }),
  )
  .middleware(AuthMiddleware);
