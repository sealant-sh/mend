import { CheckpointId, ProjectId, ServiceId, SessionId, WorktreeId } from "@mend/domain";
import {
  AgentLaunchMode,
  Change as SessionChange,
  Checkpoint,
  PreReleaseMemory,
  Preview,
  PreviewBinding,
  PreviewStatus,
  Session,
  Worktree,
  WorktreeName,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, BudgetExceeded } from "./common.ts";
import { CheckpointRequest } from "./project-environment.ts";
import {
  ObservationStamp,
  RemovalForbidden,
  RemovalInProgress,
  RemovalRefused,
  RemovalReport,
  SessionAnnotation,
  StoreFailure,
  WorktreeAnnotation,
} from "./workbench-views.ts";

// ─── The worktree container (plan §5.5/§5.6) ────────────────────────────────
// The durable named place: it owns the change, the checkpoint chain, and the
// review; sessions are conversations inside it. Removal is its own explicit
// verb, refused while any conversation is live.

export class WorktreeNotFound extends Schema.TaggedError<WorktreeNotFound>()(
  "WorktreeNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

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

const rawQuery = {
  path: Schema.String,
  within: Schema.optional(Schema.String),
  at: Schema.optional(CheckpointId),
  capture: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
};
const rawMetadata = {
  "x-mend-capture-id": Schema.optional(Schema.String),
  "x-mend-observation": Schema.optional(Schema.String),
  "content-length": Schema.String,
  "accept-ranges": Schema.Literal("bytes"),
  /** Percent-encoded canonical worktree-relative path of the opened descriptor. */
  "x-mend-file-path": Schema.String,
  /** Opaque content revision: blob identity for immutable reads, stat fingerprint for live files. */
  "x-mend-file-revision": Schema.String,
  /** Live device/inode identity, or the immutable blob revision. */
  "x-mend-file-identity": Schema.String,
};
const rawErrors = [
  WorktreeNotFound,
  RawFileNotFound,
  RawFilePreparing,
  RawFileBusy,
  RawFileTooLarge,
  BudgetExceeded,
] as const;

/** The name already names a worktree here. POST /worktrees never joins; joining is the sessions verb. */
export class WorktreeNameTaken extends Schema.TaggedError<WorktreeNameTaken>()(
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
   * The slice may have more files than `files` lists: Mend listed its first files within its
   * listing budget or deadline, the 200 `diff` renders whole when the deadline let it find them.
   * Ask for one by `path` to get it whatever its place.
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
  /** The line, cut at 2,000 characters. */
  text: Schema.String,
}) {}

/**
 * A read of a worktree's files: one file (`path`), or the lines matching a search (`query`), the
 * worktree as it stands, untracked files included and ignored ones not. Exactly one is answered.
 * A search is bounded as a whole: at most `limit` matches, 4 MiB of git's output and 10 seconds;
 * past any, what was found answers and `truncated` says so.
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

/**
 * One kept preview of the worktree (ADR 0017, "Where the link shows up"): its identity, which
 * attempt the gateway binds, and its status lines as every surface says them (`previewStatusLine`),
 * most telling first. Empty when Mend has observed and decided nothing about it worth saying.
 */
export const WorktreePreview = Schema.Struct({
  preview: Preview,
  binding: PreviewBinding,
  /** The lines as worded when the server answered. */
  status: Schema.Array(Schema.String),
  /** The same statuses as facts, for a client that words them with `previewStatusLine`. */
  facts: Schema.Array(PreviewStatus).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /**
   * Where a person opens it (`/preview-auth?preview=…&path=/`) while the gateway serves it: on,
   * and the preview bound or ended with a run a request starts. Null otherwise; a client then
   * keeps the Service's own address.
   */
  open: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The Service the gateway binds it to, and that Service's session; null while unbound. */
  boundTo: Schema.NullOr(Schema.Struct({ serviceId: ServiceId, sessionId: SessionId })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type WorktreePreview = typeof WorktreePreview.Type;

export const PreviewRoutingMode = Schema.Literals([
  "loopback-http",
  "domain-https",
  "tailnet-https",
]);
export type PreviewRoutingMode = typeof PreviewRoutingMode.Type;

/**
 * A worktree's previews, and the worktree's own line when its latest preparation names no kept
 * preview: `preview not prepared · change not captured`, or a recipe refused before any preview
 * of it existed. Null when there is none.
 */
export const WorktreePreviews = Schema.Struct({
  previews: Schema.Array(WorktreePreview),
  unprepared: Schema.NullOr(Schema.String),
  /** Whether a start of one of these previews is under way. */
  starting: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /**
   * How the gateway routes previews while it is on; null while it is off. A preview under
   * `loopback-http` lives at `*.localhost`, which only the Mend machine itself reaches.
   */
  routing: Schema.NullOr(PreviewRoutingMode).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type WorktreePreviews = typeof WorktreePreviews.Type;

export const worktreesGroup = HttpApiGroup.make("worktrees")
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/worktrees", {
      params: { id: ProjectId },
      payload: NewWorktree,
      success: Worktree,
      error: [NotFound, WorktreeNameTaken, StoreFailure, RemovalInProgress],
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
    HttpApiEndpoint.get("previews", "/worktrees/:id/previews", {
      params: { id: WorktreeId },
      success: WorktreePreviews,
      error: WorktreeNotFound,
    }),
  )
  .add(
    // The one explicit destructive act: conversations, change, chain, and review artifacts go
    // with the directory. Only the change's owner removes it. Refused, every blocker at once,
    // while anything runs or saves there, and while a change not on origin stands
    // (docs/adr/0007-landing.md, "Worktree removal"); the owner's `force=true` lifts only the
    // last.
    HttpApiEndpoint.delete("remove", "/worktrees/:id", {
      params: { id: WorktreeId },
      query: { force: Schema.optional(Schema.String) },
      success: RemovalReport,
      error: [WorktreeNotFound, RemovalForbidden, RemovalRefused, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.post("createSession", "/worktrees/:id/sessions", {
      params: { id: WorktreeId },
      payload: NewWorktreeSession,
      success: Session,
      error: [WorktreeNotFound, StoreFailure, RemovalInProgress],
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
      error: [WorktreeNotFound, StoreFailure, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("raw", "/worktrees/:id/raw", {
      params: { id: WorktreeId },
      query: rawQuery,
      // Effect 4.0.5 allows one streaming success schema, so the handler builds its range answers
      // itself: 206 with Content-Range on this schema's body, and 416 as declared below. A typed
      // client decodes 200 and the errors only; the t3code gateway reads this route as raw HTTP.
      success: HttpApiSchema.WithHeaders(HttpApiSchema.StreamUint8Array(), rawMetadata),
      error: [
        ...rawErrors,
        HttpApiSchema.WithHeaders(HttpApiSchema.Empty(416), { "content-range": Schema.String }),
      ],
    }),
  )
  .add(
    HttpApiEndpoint.head("rawHead", "/worktrees/:id/raw", {
      params: { id: WorktreeId },
      query: rawQuery,
      success: HttpApiSchema.WithHeaders(HttpApiSchema.Empty(200), rawMetadata),
      error: rawErrors,
    }),
  )
  .middleware(AuthMiddleware);
