import {
  AgentRequestId,
  AgentTurnId,
  ProjectId,
  ServiceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import {
  AgentApprovalDecision,
  AgentInputAnswers,
  AgentItem,
  AgentRequest,
  AgentTurn,
  Checkpoint,
  FollowUp,
  ReviewSlice,
  ServiceBrowserScheme,
  ServiceRecipe,
  ServiceView,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import { Change as SessionChange } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware, ProcessLogPage } from "./common.ts";
import {
  AgentRequestResolved,
  HandoffRequest,
  HandoffUnsupported,
  PastedImage,
  PastedImageRejected,
  PastedImageUpload,
} from "./project-environment.ts";
import {
  CheckpointRequest,
  DeliverFollowUpRequest,
  LaunchRequest,
  NewWorkbenchSession,
  ProtocolSessionNotLive,
  SessionDetail,
  SubmitAgentTurnRequest,
} from "./project-environment.ts";
import {
  ObservationStamp,
  RemovalReport,
  SessionActive,
  SessionNotLive,
  StoreFailure,
} from "./workbench-views.ts";

export const RespondAgentRequest = Schema.Union([
  Schema.Struct({ decision: AgentApprovalDecision }),
  Schema.Struct({ answers: AgentInputAnswers }),
]);
export type RespondAgentRequest = typeof RespondAgentRequest.Type;

/** One conversation event of the canonical session record (chat surfaces render these). */
export class TranscriptEvent extends Schema.Class<TranscriptEvent>("TranscriptEvent")({
  kind: Schema.String,
  text: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  output: Schema.NullOr(Schema.String),
}) {}

export class SessionTranscript extends Schema.Class<SessionTranscript>("SessionTranscript")({
  sourceHarness: Schema.String,
  events: Schema.Array(TranscriptEvent),
}) {}

/** Rename one live supporting shell. */
export class RenameShellRequest extends Schema.Class<RenameShellRequest>("RenameShellRequest")({
  label: Schema.String,
}) {}

/**
 * Rejoin a settled session. `harness` null keeps the current harness; `fresh` explicitly stops
 * retained supporting processes before provisioning another workspace.
 */
export class ResumeRequest extends Schema.Class<ResumeRequest>("ResumeRequest")({
  harness: Schema.NullOr(Schema.String),
  fresh: Schema.optionalKey(Schema.Boolean),
}) {}

export const sessionsGroup = HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.get("listActive", "/sessions", {
      query: { retained: Schema.optional(Schema.String) },
      success: Schema.Array(Session),
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/sessions", {
      params: { id: ProjectId },
      payload: NewWorkbenchSession,
      success: Session,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/sessions/:id", {
      params: { id: SessionId },
      success: SessionDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("submitTurn", "/sessions/:id/turns", {
      params: { id: SessionId },
      payload: SubmitAgentTurnRequest,
      success: AgentTurn,
      error: [NotFound, ProtocolSessionNotLive],
    }),
  )
  .add(
    // An image for the terminal: stored beside the session, pasted as a path.
    HttpApiEndpoint.post("pasteImage", "/sessions/:id/images", {
      params: { id: SessionId },
      payload: PastedImageUpload,
      success: PastedImage,
      error: [NotFound, StoreFailure, PastedImageRejected],
    }),
  )
  .add(
    HttpApiEndpoint.post("interruptTurn", "/turns/:id/interrupt", {
      params: { id: AgentTurnId },
      error: [NotFound, ProtocolSessionNotLive],
    }),
  )
  .add(
    HttpApiEndpoint.get("listTurns", "/sessions/:id/turns", {
      params: { id: SessionId },
      success: Schema.Array(AgentTurn),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listItems", "/sessions/:id/items", {
      params: { id: SessionId },
      query: { after: Schema.optional(Schema.String), limit: Schema.optional(Schema.String) },
      success: Schema.Array(AgentItem),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("listAgentRequests", "/sessions/:id/requests", {
      params: { id: SessionId },
      query: { pending: Schema.optional(Schema.String) },
      success: Schema.Array(AgentRequest),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("respondAgentRequest", "/requests/:id/respond", {
      params: { id: AgentRequestId },
      payload: RespondAgentRequest,
      success: AgentRequest,
      error: [NotFound, ProtocolSessionNotLive, AgentRequestResolved],
    }),
  )
  .add(
    // The plural process record (docs/SESSION-SERVICES.md): every PTY in the
    // session's workspace — agent, shells, Services — each addressable at the
    // TTY route via `?process=<id>`.
    HttpApiEndpoint.get("listProcesses", "/sessions/:id/processes", {
      params: { id: SessionId },
      success: Schema.Array(SessionProcess),
      error: NotFound,
    }),
  )
  .add(
    // The second pane (docs/SESSION-SERVICES.md): a shell PTY beside the
    // agent in the session's live workspace. Attach at /api/tty?process=<id>.
    HttpApiEndpoint.post("openShell", "/sessions/:id/shell", {
      params: { id: SessionId },
      success: SessionProcess,
      error: [NotFound, SessionNotLive, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("stopShell", "/processes/:id/stop", {
      params: { id: SessionProcessId },
      success: SessionProcess,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("renameShell", "/processes/:id/label", {
      params: { id: SessionProcessId },
      payload: RenameShellRequest,
      success: SessionProcess,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Adopt an already-listening workspace port as a Service
    // (docs/SESSION-SERVICES.md): Mend binds a host port on the private
    // interfaces and pumps each connection over a workspace forward.
    HttpApiEndpoint.post("addService", "/sessions/:id/services", {
      params: { id: SessionId },
      payload: Schema.Struct({
        port: Schema.Int,
        name: Schema.NullOr(Schema.String),
        protocol: Schema.optional(Schema.Literals(["tcp", "udp"])),
        browserScheme: Schema.optional(ServiceBrowserScheme),
      }),
      success: ServiceView,
      error: [NotFound, SessionNotLive, StoreFailure],
    }),
  )
  .add(
    // Start and supervise a Service: a PTY-backed command in the session's
    // workspace, awaited until the declared port answers.
    HttpApiEndpoint.post("runService", "/sessions/:id/services/run", {
      params: { id: SessionId },
      payload: Schema.Struct({
        argv: Schema.Array(Schema.String),
        port: Schema.Int,
        name: Schema.NullOr(Schema.String),
        protocol: Schema.optional(Schema.Literals(["tcp", "udp"])),
        browserScheme: Schema.optional(ServiceBrowserScheme),
      }),
      success: ServiceView,
      error: [NotFound, SessionNotLive, StoreFailure],
    }),
  )
  .add(
    // Resolve the declaration on the server so recipe provenance is a trusted fact.
    HttpApiEndpoint.post("runServiceRecipe", "/sessions/:id/services/recipe", {
      params: { id: SessionId },
      payload: Schema.Struct({ name: Schema.String }),
      success: ServiceView,
      error: [NotFound, SessionNotLive, StoreFailure],
    }),
  )
  .add(
    // The worktree's declared Services (mend.toml): recipes, never processes.
    HttpApiEndpoint.get("listRecipes", "/sessions/:id/recipes", {
      params: { id: SessionId },
      success: Schema.Array(ServiceRecipe),
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // What is running right now, across every session — one list, any device.
    // ?all=1 includes recently ended Services (post-mortem logs address them).
    HttpApiEndpoint.get("listServices", "/services", {
      query: { all: Schema.optional(Schema.String) },
      success: Schema.Array(ServiceView),
    }),
  )
  .add(
    // A process's recorded output — the record outlives the process AND the
    // workspace, so a dead Service's logs stay readable.
    HttpApiEndpoint.get("processLogs", "/processes/:id/logs", {
      params: { id: SessionProcessId },
      query: {
        from: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.String),
      },
      success: ProcessLogPage,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Re-run the recorded command: same row, same host port, same URL.
    HttpApiEndpoint.post("restartService", "/services/:id/restart", {
      params: { id: ServiceId },
      success: ServiceView,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("stopService", "/services/:id/stop", {
      params: { id: ServiceId },
      success: ServiceView,
      error: NotFound,
    }),
  )
  .add(
    // Settled sessions only — a live one answers 409; stop it first. Removes
    // the conversation record and its workspace ONLY: the worktree — with its
    // change, chain, and review — stands, removed by DELETE /worktrees/:id.
    HttpApiEndpoint.delete("remove", "/sessions/:id", {
      params: { id: SessionId },
      success: RemovalReport,
      error: [NotFound, SessionActive, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("label", "/sessions/:id/label", {
      params: { id: SessionId },
      payload: Schema.Struct({ label: Schema.NullOr(Schema.String) }),
      success: Session,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("stop", "/sessions/:id/stop", {
      params: { id: SessionId },
      success: Session,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("checkpoint", "/sessions/:id/checkpoints", {
      params: { id: SessionId },
      payload: CheckpointRequest,
      success: Checkpoint,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // The supervised launch (SDK 0.7.0): workspace mounts the worktree,
    // a PTY session runs argv inside it, supervision attaches — the record
    // begins here.
    HttpApiEndpoint.post("launch", "/sessions/:id/launch", {
      params: { id: SessionId },
      payload: LaunchRequest,
      success: Session,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Sessions are continuous work: rejoin one on a fresh workspace — same
    // worktree, restored harness state, native resume where the harness
    // supports it; a different harness receives the distilled conversation.
    HttpApiEndpoint.get("transcript", "/sessions/:id/transcript", {
      params: { id: SessionId },
      success: SessionTranscript,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("resume", "/sessions/:id/resume", {
      params: { id: SessionId },
      payload: ResumeRequest,
      success: Session,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Cross-mode pickup (mode handoff): continue the same provider session in
    // the requested mode — PTY ⇄ protocol, one live agent process at a time.
    HttpApiEndpoint.post("handoff", "/sessions/:id/handoff", {
      params: { id: SessionId },
      payload: HandoffRequest,
      success: Session,
      error: [NotFound, StoreFailure, HandoffUnsupported],
    }),
  )
  .add(
    HttpApiEndpoint.get("followUpPending", "/sessions/:id/follow-up", {
      params: { id: SessionId },
      success: Schema.NullOr(FollowUp),
      error: NotFound,
    }),
  )
  .add(
    // One server-owned operation: persist intent, launch, correlate membership,
    // then mark exactly the selected comments sent. Same key = same run.
    HttpApiEndpoint.post("followUpDeliver", "/sessions/:id/follow-up/deliver", {
      params: { id: SessionId },
      payload: DeliverFollowUpRequest,
      success: FollowUp,
      error: [NotFound, StoreFailure],
    }),
  )
  .middleware(AuthMiddleware);

export class ChangedFileView extends Schema.Class<ChangedFileView>("ChangedFileView")({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
}) {}

/** The change and its live diff — git is the source of truth, read at request time. */
export class ChangeDiff extends Schema.Class<ChangeDiff>("ChangeDiff")({
  change: SessionChange,
  diff: Schema.String,
  files: Schema.Array(ChangedFileView),
  /** Absent for clients that predate captures; always present from a capture-mode API. */
  observation: Schema.optionalKey(ObservationStamp),
}) {}

/**
 * A reviewer's disposition on an existing comment. `draft` is absent by
 * design — it belongs to Mend-authored findings and is machine-set only.
 */
export class SetCommentStateRequest extends Schema.Class<SetCommentStateRequest>(
  "SetCommentStateRequest",
)({
  state: Schema.Literals(["open", "addressed", "dismissed"]),
}) {}

/** Diff stats without the diff — cheap enough for a visible list row. */
export class ChangeStats extends Schema.Class<ChangeStats>("ChangeStats")({
  files: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  observation: Schema.optionalKey(ObservationStamp),
}) {}

export class OpenReviewRequest extends Schema.Class<OpenReviewRequest>("OpenReviewRequest")({
  idempotencyKey: Schema.String,
}) {}

export class OpenReviewResult extends Schema.Class<OpenReviewResult>("OpenReviewResult")({
  slice: ReviewSlice,
  checkpointA: Checkpoint,
  checkpointB: Checkpoint,
  /** True when no new review-open checkpoint was needed. */
  reused: Schema.Boolean,
}) {}

export class ReviewDiffHunkView extends Schema.Class<ReviewDiffHunkView>("ReviewDiffHunkView")({
  header: Schema.String,
  oldStart: Schema.Int,
  oldLines: Schema.Int,
  newStart: Schema.Int,
  newLines: Schema.Int,
  contextHash: Schema.String,
  patch: Schema.String,
}) {}

export class ReviewDiffFileView extends Schema.Class<ReviewDiffFileView>("ReviewDiffFileView")({
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
  patch: Schema.String,
  hunks: Schema.Array(ReviewDiffHunkView),
}) {}

export class ReviewDiffView extends Schema.Class<ReviewDiffView>("ReviewDiffView")({
  change: SessionChange,
  slice: ReviewSlice,
  checkpointA: Checkpoint,
  checkpointB: Checkpoint,
  patch: Schema.String,
  /** Files as rendered for the requested whitespace and context controls. */
  files: Schema.Array(ReviewDiffFileView),
  /** Canonical files used to create stable comment anchors across rendering controls. */
  anchorFiles: Schema.Array(ReviewDiffFileView),
  /** A live observation only; it never changes this response's patch. */
  worktreeChangedSinceSnapshot: Schema.Boolean,
  /** Which capture (or live worktree) `worktreeChangedSinceSnapshot` was observed on. */
  observation: Schema.optionalKey(ObservationStamp),
}) {}

/** Null paths = change target; paths plus null side/lines = file target. */
export class SliceCommentTargetRequest extends Schema.Class<SliceCommentTargetRequest>(
  "SliceCommentTargetRequest",
)({
  oldPath: Schema.NullOr(Schema.String),
  newPath: Schema.NullOr(Schema.String),
  side: Schema.NullOr(Schema.Literals(["old", "new"])),
  startLine: Schema.NullOr(Schema.Int),
  endLine: Schema.NullOr(Schema.Int),
  hunkContextHash: Schema.NullOr(Schema.String),
}) {}

export class NewSliceReviewCommentRequest extends Schema.Class<NewSliceReviewCommentRequest>(
  "NewSliceReviewCommentRequest",
)({
  target: SliceCommentTargetRequest,
  body: Schema.String,
}) {}
