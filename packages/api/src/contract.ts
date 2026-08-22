import type { AuthSession } from "@mend/auth";
import { NewIssue, QueueMove } from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  Brief,
  BriefComment,
  BriefVersion,
  Change,
  ChangeId,
  CheckpointId,
  Issue,
  IssueId,
  MendSettings,
  ProjectEnvironmentVariableId,
  ProjectId,
  ProjectMountId,
  ProjectSecretId,
  ReferenceId,
  ReviewCommentId,
  ReviewSliceId,
  Run,
  RunId,
  SealantRunId,
  ServiceId,
  SessionId,
  SessionProcessId,
  DotfilesRepository,
  WorkspaceImage,
} from "@mend/domain";
import {
  AgentApprovalDecision,
  AgentInputAnswers,
  AgentItem,
  AgentLaunchMode,
  AgentRequest,
  AgentTurn,
  AutomationChoice,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  SPEED_MODES,
  Change as SessionChange,
  ChangePass,
  ChangeTour,
  Checkpoint,
  DiffDigest,
  FollowUp,
  GitAuthMode,
  Project,
  ProjectEnvironmentSnapshot,
  ProjectEnvironmentVariable,
  ProjectMount,
  ProjectSecret,
  ProjectSecretsSnapshot,
  Reference,
  ReviewComment,
  ReviewSlice,
  ServiceBrowserScheme,
  ServiceRecipe,
  ServiceView,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import {
  ConnectAccountInput,
  ConnectedAccount,
  SealantConnection,
  SealantIdentity,
} from "@mend/sealant";
import { Schema } from "effect";
import * as Context from "effect/Context";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi";

/**
 * The Mend API contract — one Effect HttpApi served from the product process,
 * consumed by the web app (SSR loaders and client) and later the mobile app.
 * Contract first: this module is pure data; the server implementation lives in
 * ./server.ts, and clients derive themselves from what is declared here.
 */

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/** Who is signed in, provided to protected endpoints by the auth middleware. */
export class CurrentUser extends Context.Service<CurrentUser, AuthSession>()(
  "@mend/api/CurrentUser",
) {}

/** Cookie session (web) or bearer token (mobile) — both resolve through better-auth. */
export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  { provides: CurrentUser }
>()("@mend/api/AuthMiddleware", {
  error: Unauthorized,
}) {}

export class HealthStatus extends Schema.Class<HealthStatus>("HealthStatus")({
  status: Schema.Literals(["ok"]),
  version: Schema.String,
  /** `local` (host + Docker) or `kubernetes` (RWX store claim, network session channel). */
  deploymentMode: Schema.Literals(["local", "kubernetes"]),
  /** The central store root this instance serves; on Kubernetes the claim's mount path. */
  storeRoot: Schema.String,
  /** How workspaces reach their session: the per-session socket, or the network endpoint. */
  sessionChannel: Schema.Struct({
    mode: Schema.Literals(["unix-socket", "network"]),
    endpoint: Schema.NullOr(Schema.String),
  }),
}) {}

export class ProcessLogChunk extends Schema.Class<ProcessLogChunk>("ProcessLogChunk")({
  sequence: Schema.String,
  dataBase64: Schema.String,
}) {}

export class ProcessLogPage extends Schema.Class<ProcessLogPage>("ProcessLogPage")({
  processId: SessionProcessId,
  sealantSessionId: Schema.String,
  sealantRunId: Schema.NullOr(SealantRunId),
  requestedFrom: Schema.String,
  firstSequence: Schema.NullOr(Schema.String),
  lastSequence: Schema.NullOr(Schema.String),
  nextFrom: Schema.String,
  status: Schema.Literals(["exited", "failed", "running", "starting"]),
  chunks: Schema.Array(ProcessLogChunk),
  telemetryLoss: Schema.Literal("unknown"),
  telemetryNote: Schema.String,
}) {}

const healthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("status", "/health", { success: HealthStatus }),
);

/**
 * The machine Mend runs on, as the shell shows it: hostname · platform, and whether a
 * tailnet address is bound (plan §7.5 — the private-network promise made visible).
 * "reachable" is an observation about the interface, not a promise about routing.
 */
export class MachineView extends Schema.Class<MachineView>("MachineView")({
  hostname: Schema.String,
  platform: Schema.String,
  tailnet: Schema.Struct({
    status: Schema.Literals(["reachable", "not-detected"]),
    address: Schema.NullOr(Schema.String),
  }),
}) {}

const machineGroup = HttpApiGroup.make("machine")
  .add(HttpApiEndpoint.get("get", "/machine", { success: MachineView }))
  .middleware(AuthMiddleware);

/** The settings page's connection check — reports what was observed, never a judgment. */
const sealantGroup = HttpApiGroup.make("sealant")
  .add(HttpApiEndpoint.get("connection", "/sealant/connection", { success: SealantConnection }))
  .middleware(AuthMiddleware);

/** The platform refused the credential (format, a dead token, an unknown account). */
export class AccountRejected extends Schema.TaggedErrorClass<AccountRejected>()(
  "AccountRejected",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** The platform could not be reached or answered outside its contract. */
export class SealantUnavailable extends Schema.TaggedErrorClass<SealantUnavailable>()(
  "SealantUnavailable",
  { code: Schema.String, message: Schema.String },
  { httpApiStatus: 502 },
) {}

/**
 * The signed-in user's platform identity and connected accounts
 * (docs/SEALANT-IDENTITY.md). Secrets pass straight through to Sealant under
 * the user's own Sealant user; Mend never stores or echoes them.
 */
const accountsGroup = HttpApiGroup.make("accounts")
  .add(
    HttpApiEndpoint.get("identity", "/me/sealant", {
      success: SealantIdentity,
      error: [SealantUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("connect", "/me/sealant/accounts", {
      payload: ConnectAccountInput,
      success: ConnectedAccount,
      error: [AccountRejected, SealantUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.delete("disconnect", "/me/sealant/accounts/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: ConnectedAccount,
      error: [AccountRejected, SealantUnavailable],
    }),
  )
  .middleware(AuthMiddleware);

export class NotFound extends Schema.TaggedErrorClass<NotFound>()(
  "NotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class IssueDetail extends Schema.Class<IssueDetail>("IssueDetail")({
  issue: Issue,
  runs: Schema.Array(Run),
}) {}

/** One terminal command the run executed, from the SDK's read surface. */
export class RunCommandView extends Schema.Class<RunCommandView>("RunCommandView")({
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Number),
}) {}

/** A telemetry gap, straight from the record's loss report — never fabricated. */
export class LossSpanView extends Schema.Class<LossSpanView>("LossSpanView")({
  fromSequence: Schema.NullOr(Schema.String),
  toSequence: Schema.NullOr(Schema.String),
}) {}

/** Provenance-honest: `complete` or the exact spans that were dropped. */
export class LossReportView extends Schema.Class<LossReportView>("LossReportView")({
  complete: Schema.Boolean,
  spans: Schema.Array(LossSpanView),
}) {}

/**
 * The run detail: the indexed row plus what the record can already show
 * (commands · transcript · loss). `recordError` carries the observed failure
 * when the recording could not be read — a gap is content, not an omission.
 */
export class RunDetail extends Schema.Class<RunDetail>("RunDetail")({
  run: Run,
  commands: Schema.Array(RunCommandView),
  transcript: Schema.NullOr(Schema.String),
  loss: Schema.NullOr(LossReportView),
  recordError: Schema.NullOr(Schema.String),
}) {}

/** One timeline entry of the full trace, summary-first (typed data stays platform-side). */
export class TraceEntryView extends Schema.Class<TraceEntryView>("TraceEntryView")({
  sequence: Schema.String,
  occurredAt: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  processId: Schema.NullOr(Schema.String),
}) {}

/** A page of the full trace; `nextFrom` resumes where this page ended. */
export class TracePage extends Schema.Class<TracePage>("TracePage")({
  entries: Schema.Array(TraceEntryView),
  nextFrom: Schema.NullOr(Schema.String),
}) {}

/** One network source the run touched, aggregated from the record's source events. */
export class RunSourceView extends Schema.Class<RunSourceView>("RunSourceView")({
  host: Schema.String,
  method: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Int),
  count: Schema.Int,
  firstSequence: Schema.String,
}) {}

/** The queue: list, manual entry into triage, the Gate 1 drag, the detail views. */
const issuesGroup = HttpApiGroup.make("issues")
  .add(HttpApiEndpoint.get("list", "/issues", { success: Schema.Array(Issue) }))
  .add(HttpApiEndpoint.post("create", "/issues", { payload: NewIssue, success: Issue }))
  .add(
    HttpApiEndpoint.get("detail", "/issues/:id", {
      params: { id: IssueId },
      success: IssueDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("move", "/issues/:id/move", {
      params: { id: IssueId },
      payload: QueueMove,
      success: Issue,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** The living brief with the change it belongs to — one per issue at most. */
export class BriefDetail extends Schema.Class<BriefDetail>("BriefDetail")({
  brief: Brief,
  change: Change,
}) {}

/** A reviewer's comment as posted: the thread it anchors to, and the words. */
export class NewBriefComment extends Schema.Class<NewBriefComment>("NewBriefComment")({
  /** `q<index>` anchors a review question; `general` is the brief-wide thread. */
  thread: Schema.String,
  body: Schema.String,
}) {}

const briefsGroup = HttpApiGroup.make("briefs")
  .add(
    HttpApiEndpoint.get("byIssue", "/issues/:id/brief", {
      params: { id: IssueId },
      success: BriefDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("comments", "/issues/:id/brief/comments", {
      params: { id: IssueId },
      success: Schema.Array(BriefComment),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("comment", "/issues/:id/brief/comments", {
      params: { id: IssueId },
      payload: NewBriefComment,
      success: BriefComment,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("versions", "/issues/:id/brief/versions", {
      params: { id: IssueId },
      success: Schema.Array(BriefVersion),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

const runsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("detail", "/runs/:id", {
      params: { id: RunId },
      success: RunDetail,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("trace", "/runs/:id/trace", {
      params: { id: RunId },
      query: { from: Schema.optional(Schema.String) },
      success: TracePage,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("sources", "/runs/:id/sources", {
      params: { id: RunId },
      success: Schema.Array(RunSourceView),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

// ─── Workbench (MEND-AGENT-WORKBENCH-PLAN.md §5–§7) ─────────────────────────

/** A store or git operation that could not complete — the observed reason, verbatim. */
export class StoreFailure extends Schema.TaggedErrorClass<StoreFailure>()(
  "StoreFailure",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/** A settings update that could not be validated or persisted — the observed reason. */
export class SettingsFailure extends Schema.TaggedErrorClass<SettingsFailure>()(
  "SettingsFailure",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * Adoption: clone `source` (URL or local path) into the store under `name`.
 * `source` is any git URL — GitHub, GitLab, self-hosted, ssh://, a local path.
 * Omitted `gitAuthMode` means `ambient` (the login user's git setup).
 */
export class AdoptProject extends Schema.Class<AdoptProject>("AdoptProject")({
  name: Schema.String,
  source: Schema.String,
  gitAuthMode: Schema.optional(GitAuthMode),
}) {}

/**
 * List decoration for one session — the DB-cheap review facts (plan §6.1:
 * "which local changes have not been reviewed"). Diff stats stay behind
 * /changes/:id/stats; git is never spawned for a list.
 */
export class SessionAnnotation extends Schema.Class<SessionAnnotation>("SessionAnnotation")({
  sessionId: Schema.String,
  changeId: Schema.NullOr(ChangeId),
  openComments: Schema.Int,
  totalComments: Schema.Int,
  pendingFollowUp: Schema.Boolean,
  /**
   * The session's current agent process — newest live, else newest ever; null before the first
   * launch. List readers need it because session status is a fold over EVERY process: a
   * session reads `idle` while a shell holds the workspace after its agent ended, and this is
   * where that agent's outcome lives.
   */
  currentAgent: Schema.NullOr(SessionProcess),
}) {}

export class ProjectDetail extends Schema.Class<ProjectDetail>("ProjectDetail")({
  project: Project,
  sessions: Schema.Array(Session),
  annotations: Schema.Array(SessionAnnotation),
}) {}

/** The outcome of a destructive removal — what went, what would not. */
export class RemovalReport extends Schema.Class<RemovalReport>("RemovalReport")({
  removed: Schema.Boolean,
  leftover: Schema.NullOr(Schema.String),
}) {}

/** Deleting a live session is refused — stop it first. */
export class SessionActive extends Schema.TaggedErrorClass<SessionActive>()(
  "SessionActive",
  { id: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A supporting process needs a current reachable workspace. */
export class SessionNotLive extends Schema.TaggedErrorClass<SessionNotLive>()(
  "SessionNotLive",
  { id: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The project's stance on the automation switches — all of them, replaced together. */
export class ProjectAutomationRequest extends Schema.Class<ProjectAutomationRequest>(
  "ProjectAutomationRequest",
)({
  autoTour: AutomationChoice,
  autoSuggest: AutomationChoice,
  autoName: AutomationChoice,
}) {}

/** How host-side git reaches this project's remote (docs/GIT-ACCESS.md). */
export class ProjectGitAuthRequest extends Schema.Class<ProjectGitAuthRequest>(
  "ProjectGitAuthRequest",
)({
  gitAuthMode: GitAuthMode,
}) {}

/** The project's workspace-image override; null returns it to the Settings default. */
export class ProjectWorkspaceImageRequest extends Schema.Class<ProjectWorkspaceImageRequest>(
  "ProjectWorkspaceImageRequest",
)({
  workspaceImage: Schema.NullOr(WorkspaceImage),
}) {}

/** Whether sessions in this project receive the launching user's dotfiles. */
export class ProjectApplyDotfilesRequest extends Schema.Class<ProjectApplyDotfilesRequest>(
  "ProjectApplyDotfilesRequest",
)({
  applyDotfiles: Schema.Boolean,
}) {}

/** How many hot workspaces this project keeps ready for new sessions (0 = none). */
export class ProjectHotSessionsRequest extends Schema.Class<ProjectHotSessionsRequest>(
  "ProjectHotSessionsRequest",
)({
  hotSessions: Schema.Int.pipe(
    Schema.check(
      Schema.makeFilter((value: number) =>
        value >= 0 && value <= 8 ? undefined : "a count between 0 and 8",
      ),
    ),
  ),
}) {}

/** Observed pool state for the setup page: counts, plus the latest failure when one exists. */
export class ProjectHotSessionsStatus extends Schema.Class<ProjectHotSessionsStatus>(
  "ProjectHotSessionsStatus",
)({
  hotSessions: Schema.Int,
  ready: Schema.Int,
  warming: Schema.Int,
  failed: Schema.Int,
  error: Schema.NullOr(Schema.String),
}) {}

/** One file in the user's dotfiles snapshot — path relative to `~`, size as a fact. */
export class DotfilesSnapshotFileView extends Schema.Class<DotfilesSnapshotFileView>(
  "DotfilesSnapshotFileView",
)({
  path: Schema.String,
  bytes: Schema.Int,
}) {}

/** The user's current snapshot in the dotfiles store: an exact commit, source machine recorded. */
export class DotfilesSnapshotView extends Schema.Class<DotfilesSnapshotView>(
  "DotfilesSnapshotView",
)({
  sha: Schema.String,
  source: Schema.String,
  committedAt: Schema.Date,
  files: Schema.Array(DotfilesSnapshotFileView),
}) {}

/** The current user's dotfiles: repository config + store snapshot. Dotfiles are per-account. */
export class DotfilesView extends Schema.Class<DotfilesView>("DotfilesView")({
  repository: Schema.NullOr(DotfilesRepository),
  snapshot: Schema.NullOr(DotfilesSnapshotView),
}) {}

/**
 * Files streamed into the user's dotfiles store — contents captured on the machine that HAS
 * them (`mend dotfiles sync`, a web upload), never scanned off the server's own home. `merge`
 * overlays the current snapshot (web add-a-file); replace supersedes it (CLI sync).
 */
export class DotfilesSnapshotRequest extends Schema.Class<DotfilesSnapshotRequest>(
  "DotfilesSnapshotRequest",
)({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      contentsBase64: Schema.String,
      mode: Schema.optional(Schema.String),
    }),
  ),
  source: Schema.String,
  merge: Schema.Boolean,
}) {}

export class DotfilesRepositoryRequest extends Schema.Class<DotfilesRepositoryRequest>(
  "DotfilesRepositoryRequest",
)({
  repository: Schema.NullOr(DotfilesRepository),
}) {}

/**
 * The machine's Mend deploy key — public half only; the private key never
 * leaves the host and never crosses this API. `exists: false` is status, not
 * an error: no key has been generated yet.
 */
export class GitKeyView extends Schema.Class<GitKeyView>("GitKeyView")({
  exists: Schema.Boolean,
  publicKey: Schema.NullOr(Schema.String),
  fingerprint: Schema.NullOr(Schema.String),
}) {}

/**
 * The ssh-agent bridge, as observed right now: whether a `mend keys share`
 * is connected and what that machine calls itself. Presence is a fact, not
 * a verdict — git ops for bridge-mode projects need it, and fail readably
 * without it.
 */
export class GitBridgeStatusView extends Schema.Class<GitBridgeStatusView>("GitBridgeStatusView")({
  connected: Schema.Boolean,
  clientName: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.Date),
}) {}

export const HostToolSuggestionView = Schema.Struct({
  executable: Schema.String,
  kind: Schema.Literals(["package", "service"]),
  id: Schema.String,
});

export const HostConfigSuggestionView = Schema.Struct({
  label: Schema.String,
  path: Schema.String,
});

export const HostEnvironmentSuggestionsView = Schema.Struct({
  tools: Schema.Array(HostToolSuggestionView),
  configs: Schema.Array(HostConfigSuggestionView),
});

export class WorkspacePackageResolutionView extends Schema.Class<WorkspacePackageResolutionView>(
  "WorkspacePackageResolutionView",
)({
  requested: Schema.String,
  normalized: Schema.String,
  status: Schema.Literals(["resolved", "ambiguous", "unsupported", "not-found", "invalid"]),
  canonicalId: Schema.NullOr(Schema.String),
  supported: Schema.Boolean,
  packageName: Schema.NullOr(Schema.String),
  alternatives: Schema.Array(Schema.String),
}) {}

/**
 * Saving a project override resolves family-mode packages exactly like the settings save;
 * `saved: false` reports the rejections and persists nothing. Custom-mode packages pass through
 * verbatim (the base's own package manager owns them), so they carry no resolutions.
 */
export class ProjectWorkspaceImageSaveResult extends Schema.Class<ProjectWorkspaceImageSaveResult>(
  "ProjectWorkspaceImageSaveResult",
)({
  saved: Schema.Boolean,
  project: Schema.NullOr(Project),
  resolutions: Schema.Array(WorkspacePackageResolutionView),
}) {}

export class WorkspaceEnvironmentSaveResult extends Schema.Class<WorkspaceEnvironmentSaveResult>(
  "WorkspaceEnvironmentSaveResult",
)({
  saved: Schema.Boolean,
  settings: MendSettings,
  resolutions: Schema.Array(WorkspacePackageResolutionView),
}) {}

/**
 * Product settings, one document (the review-automation cascade's root:
 * project `inherit` resolves against these defaults). PUT replaces the whole
 * document — clients edit what GET returned.
 */
const settingsGroup = HttpApiGroup.make("settings")
  .add(HttpApiEndpoint.get("get", "/settings", { success: MendSettings }))
  .add(
    HttpApiEndpoint.get("scanHostEnvironment", "/settings/environment-suggestions", {
      success: HostEnvironmentSuggestionsView,
    }),
  )
  .add(
    HttpApiEndpoint.put("set", "/settings", {
      payload: MendSettings,
      success: MendSettings,
      error: SettingsFailure,
    }),
  )
  .add(
    HttpApiEndpoint.put("setWorkspaceEnvironment", "/settings/workspace-environment", {
      payload: WorkspaceImage,
      success: WorkspaceEnvironmentSaveResult,
      error: SettingsFailure,
    }),
  )
  .middleware(AuthMiddleware);

/**
 * The current user's dotfiles (plan: dotfiles are identity, not instance settings): the store
 * snapshot synced from their own machine, and the repository knob. Every route acts as the
 * authenticated account.
 */
const dotfilesGroup = HttpApiGroup.make("dotfiles")
  .add(HttpApiEndpoint.get("get", "/dotfiles", { success: DotfilesView }))
  .add(
    HttpApiEndpoint.put("repository", "/dotfiles/repository", {
      payload: DotfilesRepositoryRequest,
      success: DotfilesView,
      error: SettingsFailure,
    }),
  )
  .add(
    HttpApiEndpoint.post("snapshot", "/dotfiles/snapshot", {
      payload: DotfilesSnapshotRequest,
      success: DotfilesView,
      error: SettingsFailure,
    }),
  )
  .add(
    HttpApiEndpoint.delete("clearSnapshot", "/dotfiles/snapshot", {
      success: DotfilesView,
      error: SettingsFailure,
    }),
  )
  .middleware(AuthMiddleware);

/**
 * A flat path listing of a project's files, from the focused session's live
 * worktree when one is named (tracked + untracked, ignore rules applied) or
 * from the default branch's tree in the bare store otherwise. The client
 * nests; the server caps and says so.
 */
export class ProjectFileListing extends Schema.Class<ProjectFileListing>("ProjectFileListing")({
  /** `worktree` = a session's live checkout; `branch` = a commit tree in the store. */
  source: Schema.Literals(["worktree", "branch"]),
  /** The worktree name or the branch name the listing was read from. */
  label: Schema.String,
  /** Absolute path for a worktree listing; null for a tree read from the bare repo. */
  rootPath: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
}) {}

/** One pull request exactly as gh reported it — a reference, never a verdict. */
export class PullRequestView extends Schema.Class<PullRequestView>("PullRequestView")({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  isDraft: Schema.Boolean,
  url: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  author: Schema.NullOr(Schema.String),
  /** GitHub's own review state word (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED) or null. */
  reviewDecision: Schema.NullOr(Schema.String),
  additions: Schema.Int,
  deletions: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
}) {}

/**
 * The project's pull requests, or the exact reason there are none to show.
 * `origin` says whether the project even points at GitHub; `availability`
 * says whether the host's gh could answer; `detail` is gh's own words.
 */
export class ProjectPullRequests extends Schema.Class<ProjectPullRequests>("ProjectPullRequests")({
  origin: Schema.Literals(["none", "not-github", "github"]),
  /** owner/name when the origin is GitHub. */
  repo: Schema.NullOr(Schema.String),
  availability: Schema.Literals([
    "ok",
    "no-origin",
    "not-github",
    "gh-missing",
    "gh-signed-out",
    "rate-limited",
    "error",
  ]),
  detail: Schema.NullOr(Schema.String),
  pullRequests: Schema.Array(PullRequestView),
  /** When gh answered, the moment it did; null otherwise. */
  fetchedAt: Schema.NullOr(Schema.String),
}) {}

const projectsGroup = HttpApiGroup.make("projects")
  .add(HttpApiEndpoint.get("list", "/projects", { success: Schema.Array(Project) }))
  .add(
    HttpApiEndpoint.post("adopt", "/projects", {
      payload: AdoptProject,
      success: Project,
      error: StoreFailure,
    }),
  )
  .add(
    HttpApiEndpoint.get("detail", "/projects/:id", {
      params: { id: ProjectId },
      success: ProjectDetail,
      error: NotFound,
    }),
  )
  .add(
    // Removal stops the project's live sessions, deletes every row under it,
    // and removes the store copy. `leftover` reports a path that would not
    // delete (container-uid files) — honesty over a false clean.
    HttpApiEndpoint.delete("remove", "/projects/:id", {
      params: { id: ProjectId },
      success: RemovalReport,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.put("automation", "/projects/:id/automation", {
      params: { id: ProjectId },
      payload: ProjectAutomationRequest,
      success: Project,
      error: NotFound,
    }),
  )
  .add(
    // Switching to mend-key generates the machine key if missing, so the
    // response is immediately followed by a public key the UI can show.
    HttpApiEndpoint.put("gitAuth", "/projects/:id/git-auth", {
      params: { id: ProjectId },
      payload: ProjectGitAuthRequest,
      success: Project,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.put("workspaceImage", "/projects/:id/workspace-image", {
      params: { id: ProjectId },
      payload: ProjectWorkspaceImageRequest,
      success: ProjectWorkspaceImageSaveResult,
      error: Schema.Union([NotFound, SettingsFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.put("applyDotfiles", "/projects/:id/apply-dotfiles", {
      params: { id: ProjectId },
      payload: ProjectApplyDotfilesRequest,
      success: Project,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("hotSessions", "/projects/:id/hot-sessions", {
      params: { id: ProjectId },
      payload: ProjectHotSessionsRequest,
      success: Project,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("hotSessionsStatus", "/projects/:id/hot-sessions", {
      params: { id: ProjectId },
      success: ProjectHotSessionsStatus,
      error: NotFound,
    }),
  )
  .add(
    // `?session=` roots the listing at that session's live worktree; absent,
    // the default branch's tree in the bare store. A session from another
    // project answers 404.
    HttpApiEndpoint.get("files", "/projects/:id/files", {
      params: { id: ProjectId },
      query: { session: Schema.optional(SessionId) },
      success: ProjectFileListing,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Never errors on GitHub's behalf: a missing origin, a non-GitHub origin,
    // an absent or signed-out gh, and a rate limit are all answered as state.
    HttpApiEndpoint.get("pullRequests", "/projects/:id/pull-requests", {
      params: { id: ProjectId },
      success: ProjectPullRequests,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/**
 * The machine's Mend git key (docs/GIT-ACCESS.md). GET reads; POST generates
 * on first use ("mend keys init"). One key per machine today — the per-user
 * seam arrives with multi-tenant identity.
 */
const gitKeysGroup = HttpApiGroup.make("gitKeys")
  .add(HttpApiEndpoint.get("show", "/keys/git", { success: GitKeyView }))
  .add(HttpApiEndpoint.post("init", "/keys/git", { success: GitKeyView, error: StoreFailure }))
  .add(HttpApiEndpoint.get("bridgeStatus", "/keys/bridge", { success: GitBridgeStatusView }))
  .middleware(AuthMiddleware);

/** Add a reference: clone `source` shallow into the store, pinned to `ref` when given. */
export class AddReference extends Schema.Class<AddReference>("AddReference")({
  name: Schema.String,
  source: Schema.String,
  /** Branch or tag to hold the clone at; null = the remote's default branch. */
  ref: Schema.NullOr(Schema.String),
}) {}

/** The project's selection, replaced as a set — what its sessions will mount. */
export class ProjectReferenceSelection extends Schema.Class<ProjectReferenceSelection>(
  "ProjectReferenceSelection",
)({
  referenceIds: Schema.Array(ReferenceId),
}) {}

/**
 * References (plan §17, decided 2026-08-01): a global list of read-only
 * dependency clones, selected per project, mounted at `/workspace/ref/<name>`.
 */
const referencesGroup = HttpApiGroup.make("references")
  .add(HttpApiEndpoint.get("list", "/references", { success: Schema.Array(Reference) }))
  .add(
    HttpApiEndpoint.post("add", "/references", {
      payload: AddReference,
      success: Reference,
      error: StoreFailure,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/references/:id", {
      params: { id: ReferenceId },
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("refresh", "/references/:id/refresh", {
      params: { id: ReferenceId },
      success: Reference,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.get("forProject", "/projects/:id/references", {
      params: { id: ProjectId },
      success: Schema.Array(Reference),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("selectForProject", "/projects/:id/references", {
      params: { id: ProjectId },
      payload: ProjectReferenceSelection,
      success: Schema.Array(Reference),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** Declare a host folder the project's sessions can see; read-only unless chosen otherwise. */
export class AddProjectMount extends Schema.Class<AddProjectMount>("AddProjectMount")({
  name: Schema.String,
  hostPath: Schema.String,
  readOnly: Schema.Boolean,
}) {}

/**
 * Per-project extra mounts (plan §17, decided 2026-08-01): host folders
 * mounted at `/workspace/home/<name>` in the project's sessions. The review
 * scope is unchanged — mounts widen what the agent can see, never what Mend
 * reviews.
 */
const projectMountsGroup = HttpApiGroup.make("projectMounts")
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/mounts", {
      params: { id: ProjectId },
      success: Schema.Array(ProjectMount),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/projects/:id/mounts", {
      params: { id: ProjectId },
      payload: AddProjectMount,
      success: ProjectMount,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/mounts/:mountId", {
      params: { id: ProjectId, mountId: ProjectMountId },
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** One name/value to create; ordinary configuration only — stored and returned as plaintext. */
export class ProjectEnvironmentVariableRequest extends Schema.Class<ProjectEnvironmentVariableRequest>(
  "ProjectEnvironmentVariableRequest",
)({
  name: Schema.String,
  /** Empty string is a valid value ("set to empty"). */
  value: Schema.String,
}) {}

/** Atomic edit/rename of one stable ID; requires the last-seen integer row revision. */
export class ProjectEnvironmentVariableUpdateRequest extends Schema.Class<ProjectEnvironmentVariableUpdateRequest>(
  "ProjectEnvironmentVariableUpdateRequest",
)({
  name: Schema.String,
  value: Schema.String,
  expectedRevision: Schema.Int,
}) {}

export class ProjectEnvironmentVariableRemoveRequest extends Schema.Class<ProjectEnvironmentVariableRemoveRequest>(
  "ProjectEnvironmentVariableRemoveRequest",
)({
  expectedRevision: Schema.Int,
}) {}

/** A mutation's result: the touched variable (absent after delete) + new aggregate revision. */
export class ProjectEnvironmentMutationResult extends Schema.Class<ProjectEnvironmentMutationResult>(
  "ProjectEnvironmentMutationResult",
)({
  variable: Schema.NullOr(ProjectEnvironmentVariable),
  revision: Schema.Int,
}) {}

/**
 * A refused environment write: which field broke which rule, with the same wording the UI shows.
 * Duplicates and per-project limits arrive as issues too (`duplicate-name`, `entry-count`,
 * `total-size`, with `field: null` for the aggregate ones). Values never appear.
 */
export class EnvironmentRejected extends Schema.TaggedErrorClass<EnvironmentRejected>()(
  "EnvironmentRejected",
  {
    issues: Schema.Array(
      Schema.Struct({
        field: Schema.NullOr(Schema.Literals(["name", "value"])),
        rule: Schema.String,
        message: Schema.String,
      }),
    ),
  },
  { httpApiStatus: 422 },
) {}

/** The row moved since the caller read it. The browser keeps its draft; nothing was written. */
export class EnvironmentStaleWrite extends Schema.TaggedErrorClass<EnvironmentStaleWrite>()(
  "EnvironmentStaleWrite",
  {
    variableId: Schema.String,
    currentRevision: Schema.Int,
  },
  { httpApiStatus: 409 },
) {}

/**
 * Load a `.env` into the project store (`mend env load`, the "Load a .env" panel): the raw file
 * text, parsed and routed SERVER-SIDE. Each entry goes by NAME to Configuration or Secrets — or
 * everything acceptable to Secrets with `allSecret`, or the listed `secretNames` — create-or-
 * replace by name; the file is the intent. Values cross this request only; the response never
 * carries one.
 */
export class EnvironmentLoadRequest extends Schema.Class<EnvironmentLoadRequest>(
  "EnvironmentLoadRequest",
)({
  contents: Schema.String,
  allSecret: Schema.Boolean,
  secretNames: Schema.Array(Schema.String),
}) {}

export class EnvironmentLoadedEntry extends Schema.Class<EnvironmentLoadedEntry>(
  "EnvironmentLoadedEntry",
)({
  name: Schema.String,
  lane: Schema.Literals(["configuration", "secret"]),
  /** `moved` = it also left the other lane (a name lives in exactly one). */
  action: Schema.Literals(["created", "updated", "moved"]),
}) {}

export class EnvironmentRejectedEntry extends Schema.Class<EnvironmentRejectedEntry>(
  "EnvironmentRejectedEntry",
)({
  name: Schema.String,
  reason: Schema.String,
}) {}

/** The per-name report: what landed where, and what was refused and why. Never a value. */
export class EnvironmentLoadReport extends Schema.Class<EnvironmentLoadReport>(
  "EnvironmentLoadReport",
)({
  loaded: Schema.Array(EnvironmentLoadedEntry),
  rejected: Schema.Array(EnvironmentRejectedEntry),
  /** Line numbers the parser could not read as `NAME=value`; nothing on them was stored. */
  malformedLines: Schema.Array(Schema.Int),
  environmentRevision: Schema.Int,
  secretRevision: Schema.Int,
}) {}

/**
 * Project environment variables (`.plans/project-environment-variables.md`): project-owned,
 * explicitly NON-SECRET configuration inherited by every process in the project's future
 * workspaces. Values ride only this group — project detail, session detail, and events carry
 * pointers or names, never values. Changes apply to new workspace launches (including
 * settled-session resume); a running workspace keeps what it started with.
 */
const projectEnvironmentGroup = HttpApiGroup.make("projectEnvironment")
  .add(
    HttpApiEndpoint.get("get", "/projects/:id/environment", {
      params: { id: ProjectId },
      success: ProjectEnvironmentSnapshot,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/environment/variables", {
      params: { id: ProjectId },
      payload: ProjectEnvironmentVariableRequest,
      success: ProjectEnvironmentMutationResult,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [NotFound, EnvironmentRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/projects/:id/environment/variables/:variableId", {
      params: { id: ProjectId, variableId: ProjectEnvironmentVariableId },
      payload: ProjectEnvironmentVariableUpdateRequest,
      success: ProjectEnvironmentMutationResult,
      error: [NotFound, EnvironmentRejected, EnvironmentStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/environment/variables/:variableId", {
      params: { id: ProjectId, variableId: ProjectEnvironmentVariableId },
      payload: ProjectEnvironmentVariableRemoveRequest,
      success: ProjectEnvironmentMutationResult,
      error: [NotFound, EnvironmentStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.post("load", "/projects/:id/environment/load", {
      params: { id: ProjectId },
      payload: EnvironmentLoadRequest,
      success: EnvironmentLoadReport,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** Create a secret: the value is sealed at rest and never returned by any response. */
export class ProjectSecretRequest extends Schema.Class<ProjectSecretRequest>(
  "ProjectSecretRequest",
)({
  name: Schema.String,
  value: Schema.String,
}) {}

/**
 * Replace a secret's value and/or rename it. `value: null` keeps the stored value (pure rename);
 * a string replaces it. Requires the last-seen row revision.
 */
export class ProjectSecretUpdateRequest extends Schema.Class<ProjectSecretUpdateRequest>(
  "ProjectSecretUpdateRequest",
)({
  name: Schema.String,
  value: Schema.NullOr(Schema.String),
  expectedRevision: Schema.Int,
}) {}

export class ProjectSecretRemoveRequest extends Schema.Class<ProjectSecretRemoveRequest>(
  "ProjectSecretRemoveRequest",
)({
  expectedRevision: Schema.Int,
}) {}

/** A secret mutation's result: the touched row (name/revision only) + new aggregate revision. */
export class ProjectSecretMutationResult extends Schema.Class<ProjectSecretMutationResult>(
  "ProjectSecretMutationResult",
)({
  secret: Schema.NullOr(ProjectSecret),
  revision: Schema.Int,
}) {}

/**
 * Project SECRETS (`.plans/project-environment-variables.md`, "Scope expansion"): the encrypted,
 * write-only half of the project env store. Responses carry names and revisions only — a value
 * that has been written can never be read back through this API. At launch the current set goes
 * to Sealant's transient secret channel, which keeps it out of the blueprint, container env, and
 * captured output. Same lifecycle as Configuration: new workspace launches only.
 */
const projectSecretsGroup = HttpApiGroup.make("projectSecrets")
  .add(
    HttpApiEndpoint.get("get", "/projects/:id/secrets", {
      params: { id: ProjectId },
      success: ProjectSecretsSnapshot,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("create", "/projects/:id/secrets", {
      params: { id: ProjectId },
      payload: ProjectSecretRequest,
      success: ProjectSecretMutationResult,
      error: [NotFound, EnvironmentRejected],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/projects/:id/secrets/:secretId", {
      params: { id: ProjectId, secretId: ProjectSecretId },
      payload: ProjectSecretUpdateRequest,
      success: ProjectSecretMutationResult,
      error: [NotFound, EnvironmentRejected, EnvironmentStaleWrite],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/secrets/:secretId", {
      params: { id: ProjectId, secretId: ProjectSecretId },
      payload: ProjectSecretRemoveRequest,
      success: ProjectSecretMutationResult,
      error: [NotFound, EnvironmentStaleWrite],
    }),
  )
  .middleware(AuthMiddleware);

/** Declare a Service on the project itself; command-less = adopt-only. */
export class AddProjectServiceRecipe extends Schema.Class<AddProjectServiceRecipe>(
  "AddProjectServiceRecipe",
)({
  name: Schema.String,
  command: Schema.NullOr(Schema.String),
  port: Schema.Int,
  protocol: Schema.optional(Schema.Literals(["tcp", "udp"])),
  browserScheme: Schema.optional(ServiceBrowserScheme),
}) {}

/**
 * Project-level Service recipes (docs/SESSION-SERVICES.md): the web-editable
 * twin of mend.toml, stored on this machine. Sessions see the union of both;
 * on a name collision the file wins — it travels with the repo.
 */
const projectRecipesGroup = HttpApiGroup.make("projectRecipes")
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/service-recipes", {
      params: { id: ProjectId },
      success: Schema.Array(ServiceRecipe),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/projects/:id/service-recipes", {
      params: { id: ProjectId },
      payload: AddProjectServiceRecipe,
      success: ServiceRecipe,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/service-recipes/:name", {
      params: { id: ProjectId, name: Schema.String },
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/** Provisioning a session: the worktree exists after this; launching is separate. */
export class NewWorkbenchSession extends Schema.Class<NewWorkbenchSession>("NewWorkbenchSession")({
  harness: Schema.String,
  /** Intended agent launch shape; omitted keeps the PTY default. */
  mode: Schema.optional(AgentLaunchMode),
  label: Schema.NullOr(Schema.String),
  /** Branch or sha to base the worktree on; null = the project's default branch. */
  base: Schema.NullOr(Schema.String),
}) {}

export class SessionDetail extends Schema.Class<SessionDetail>("SessionDetail")({
  session: Session,
  checkpoints: Schema.Array(Checkpoint),
  change: Schema.NullOr(SessionChange),
  /** Every process the session has held, oldest first — agents, shells, Service attempts. */
  processes: Schema.Array(SessionProcess),
  /** The agent process "the session's agent" means right now; null before the first launch. */
  currentAgent: Schema.NullOr(SessionProcess),
}) {}

/** The API takes only the human-initiated triggers; the engine owns the rest. */
export class CheckpointRequest extends Schema.Class<CheckpointRequest>("CheckpointRequest")({
  trigger: Schema.Literals(["review-open", "user-mark"]),
}) {}

/** Immutable Review bundle plus the exact edited instruction and client retry key. */
export class DeliverFollowUpRequest extends Schema.Class<DeliverFollowUpRequest>(
  "DeliverFollowUpRequest",
)({
  reviewSliceId: ReviewSliceId,
  checkpointAId: CheckpointId,
  checkpointBId: CheckpointId,
  diffDigest: DiffDigest,
  commentIds: Schema.Array(ReviewCommentId),
  instruction: Schema.String,
  idempotencyKey: Schema.String,
}) {}

/**
 * What to run in the session's PTY. Two shapes: verbatim `argv` (argv[0] is
 * the program; wins when present), or the structured start — the server
 * composes the harness argv from it in one place (`composeLaunchArgv`).
 */
export class LaunchRequest extends Schema.Class<LaunchRequest>("LaunchRequest")({
  /** Omitted keeps the existing PTY launch shape. */
  mode: Schema.optional(AgentLaunchMode),
  argv: Schema.optional(Schema.Array(Schema.String)),
  /** The typed first message; rides the harness argv and seeds auto-naming. */
  prompt: Schema.optional(Schema.String),
  /** Free-form harness model id; HARNESS_MODELS is advisory, for pickers. */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Literals(EFFORT_LEVELS)),
  permissionMode: Schema.optional(Schema.Literals(PERMISSION_MODES)),
  /** `fast` = priority processing where the harness supports it (codex). */
  speed: Schema.optional(Schema.Literals(SPEED_MODES)),
}) {}

/** Submit one authored input to the live protocol process. */
export class SubmitAgentTurnRequest extends Schema.Class<SubmitAgentTurnRequest>(
  "SubmitAgentTurnRequest",
)({
  input: Schema.String,
}) {}

/** A live protocol process is required for this operation. */
export class ProtocolSessionNotLive extends Schema.TaggedErrorClass<ProtocolSessionNotLive>()(
  "ProtocolSessionNotLive",
  { processId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The request already has an observed answer or cancellation. */
export class AgentRequestResolved extends Schema.TaggedErrorClass<AgentRequestResolved>()(
  "AgentRequestResolved",
  { requestId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Approval and structured-input responses are disjoint on the wire. */
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

const sessionsGroup = HttpApiGroup.make("sessions")
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
      error: Schema.Union([NotFound, StoreFailure]),
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
      error: Schema.Union([NotFound, SessionNotLive, StoreFailure]),
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
      error: Schema.Union([NotFound, StoreFailure]),
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
    // Settled sessions only — a live one answers 409; stop it first. Takes
    // the worktree with it; checkpoints' refs survive in the bare repo.
    HttpApiEndpoint.delete("remove", "/sessions/:id", {
      params: { id: SessionId },
      success: RemovalReport,
      error: Schema.Union([NotFound, SessionActive, StoreFailure]),
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
      error: Schema.Union([NotFound, StoreFailure]),
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
      error: Schema.Union([NotFound, StoreFailure]),
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
      error: Schema.Union([NotFound, StoreFailure]),
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

const sessionChangesGroup = HttpApiGroup.make("sessionChanges")
  .add(
    HttpApiEndpoint.post("openReview", "/changes/:id/reviews/open", {
      params: { id: ChangeId },
      payload: OpenReviewRequest,
      success: OpenReviewResult,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.get("reviewDiff", "/changes/:id/reviews/:sliceId/diff", {
      params: { id: ChangeId, sliceId: ReviewSliceId },
      query: {
        whitespace: Schema.optional(Schema.Literals(["include", "ignore"])),
        context: Schema.optional(Schema.String),
      },
      success: ReviewDiffView,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.post("sliceComment", "/changes/:id/reviews/:sliceId/comments", {
      params: { id: ChangeId, sliceId: ReviewSliceId },
      payload: NewSliceReviewCommentRequest,
      success: ReviewComment,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    /** Retained temporarily for legacy clients; new Review surfaces use explicit slices. */
    HttpApiEndpoint.get("diff", "/changes/:id/diff", {
      params: { id: ChangeId },
      success: ChangeDiff,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.get("stats", "/changes/:id/stats", {
      params: { id: ChangeId },
      success: ChangeStats,
      error: Schema.Union([NotFound, StoreFailure]),
    }),
  )
  .add(
    HttpApiEndpoint.get("comments", "/changes/:id/comments", {
      params: { id: ChangeId },
      success: Schema.Array(ReviewComment),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("commentState", "/changes/:id/comments/:commentId/state", {
      params: { id: ChangeId, commentId: ReviewCommentId },
      payload: SetCommentStateRequest,
      success: ReviewComment,
      error: NotFound,
    }),
  )
  .add(
    // "Read this change" (plan §7.3): queue the machine pass; findings land
    // asynchronously as draft comments and arrive over the normal SSE path.
    HttpApiEndpoint.post("read", "/changes/:id/read", {
      params: { id: ChangeId },
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: NotFound,
    }),
  )
  .add(
    // The composed review tour: null until composed; SSE announces arrival.
    HttpApiEndpoint.get("tour", "/changes/:id/tour", {
      params: { id: ChangeId },
      success: Schema.NullOr(ChangeTour),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("composeTour", "/changes/:id/tour", {
      params: { id: ChangeId },
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: NotFound,
    }),
  )
  .add(
    // The suggestion pass: queue it; suggestions land asynchronously as
    // draft comments carrying exact replacements, over the normal SSE path.
    HttpApiEndpoint.post("suggest", "/changes/:id/suggest", {
      params: { id: ChangeId },
      success: Schema.Struct({ queued: Schema.Boolean }),
      error: NotFound,
    }),
  )
  .add(
    // What ran over this change and what came of it — one row per pass kind.
    HttpApiEndpoint.get("passes", "/changes/:id/passes", {
      params: { id: ChangeId },
      success: Schema.Array(ChangePass),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);

/**
 * Adoption discovery: the host's GitHub CLI answers with the credentials it
 * already holds — Mend adds none of its own. What was observed about gh
 * (missing, signed out) is status content, never a hidden error; clients fall
 * back to a typed source. No new product noun — this is still adoption.
 */
export class GhStatusView extends Schema.Class<GhStatusView>("GhStatusView")({
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  /** The account gh reports as active, when signed in. */
  login: Schema.NullOr(Schema.String),
  /** The CLI's own words when discovery cannot serve — verbatim, never rephrased. */
  detail: Schema.NullOr(Schema.String),
}) {}

/** One repository exactly as gh reported it (list and search shapes normalized). */
export class GhRepoView extends Schema.Class<GhRepoView>("GhRepoView")({
  nameWithOwner: Schema.String,
  description: Schema.NullOr(Schema.String),
  visibility: Schema.String,
  isFork: Schema.Boolean,
  language: Schema.NullOr(Schema.String),
  stars: Schema.Int,
  pushedAt: Schema.NullOr(Schema.String),
  url: Schema.String,
}) {}

/** A gh invocation that could not answer — its stderr, verbatim. */
export class GhFailure extends Schema.TaggedErrorClass<GhFailure>()(
  "GhFailure",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

const githubGroup = HttpApiGroup.make("github")
  .add(HttpApiEndpoint.get("status", "/github/status", { success: GhStatusView }))
  .add(
    HttpApiEndpoint.get("repos", "/github/repos", {
      query: { query: Schema.optional(Schema.String) },
      success: Schema.Array(GhRepoView),
      error: GhFailure,
    }),
  )
  .middleware(AuthMiddleware);

/** An Expo push token registration — one per app install, token is identity. */
export class RegisterDeviceRequest extends Schema.Class<RegisterDeviceRequest>(
  "RegisterDeviceRequest",
)({
  token: Schema.String,
  platform: Schema.String,
}) {}

export class RegisteredDevice extends Schema.Class<RegisteredDevice>("RegisteredDevice")({
  token: Schema.String,
  platform: Schema.String,
}) {}

const devicesGroup = HttpApiGroup.make("devices")
  .add(
    HttpApiEndpoint.post("register", "/devices", {
      payload: RegisterDeviceRequest,
      success: RegisteredDevice,
    }),
  )
  .add(
    HttpApiEndpoint.delete("unregister", "/devices/:token", {
      params: { token: Schema.String },
    }),
  )
  .middleware(AuthMiddleware);

/** The platforms a paired device can report itself as. */
export const DEVICE_PLATFORMS = ["ios", "android", "web", "desktop", "other"] as const;

/** One device paired to the signed-in user. Revoked devices drop off the list. */
export class DeviceView extends Schema.Class<DeviceView>("DeviceView")({
  id: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
}) {}

/**
 * A freshly minted pairing code plus the base URLs this machine answers on —
 * the tailnet address first, then non-internal LAN IPv4s. Reachability is the
 * phone's to observe; these are candidates, not a promise.
 */
export class PairingView extends Schema.Class<PairingView>("PairingView")({
  code: Schema.String,
  expiresAt: Schema.String,
  urls: Schema.Array(Schema.String),
}) {}

/** What a phone sends to claim a code: the code as typed, and what to call the device. */
export class PairClaimRequest extends Schema.Class<PairClaimRequest>("PairClaimRequest")({
  code: Schema.String,
  name: Schema.String,
  platform: Schema.Literals(DEVICE_PLATFORMS),
}) {}

/** The claimed token, shown once. Mend keeps only its sha256. */
export class PairClaimResult extends Schema.Class<PairClaimResult>("PairClaimResult")({
  token: Schema.String,
  url: Schema.String,
  user: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
  }),
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
}) {}

/** No pairing code with that value. */
export class PairingCodeNotFound extends Schema.TaggedErrorClass<PairingCodeNotFound>()(
  "PairingCodeNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The code exists but is spent — past its expiry, or already claimed. */
export class PairingCodeSpent extends Schema.TaggedErrorClass<PairingCodeSpent>()(
  "PairingCodeSpent",
  {},
  { httpApiStatus: 410 },
) {}

/** Too many failed claims from one address. `/pair` is unauthenticated; this is its floor. */
export class PairingRateLimited extends Schema.TaggedErrorClass<PairingRateLimited>()(
  "PairingRateLimited",
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {}

/**
 * The signed-in user's paired devices, and the codes that mint them. A device
 * holds a bearer token of its own: revoking the device is what ends its access.
 */
const userDevicesGroup = HttpApiGroup.make("userDevices")
  .add(HttpApiEndpoint.post("createPairing", "/me/devices/pairings", { success: PairingView }))
  .add(HttpApiEndpoint.get("list", "/me/devices", { success: Schema.Array(DeviceView) }))
  .add(
    HttpApiEndpoint.delete("revoke", "/me/devices/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: DeviceView,
      error: [NotFound],
    }),
  )
  .middleware(AuthMiddleware);

/**
 * Claiming a pairing code. Unauthenticated by construction — the code is the
 * only credential the phone has, and it is single use.
 */
const pairGroup = HttpApiGroup.make("pair").add(
  HttpApiEndpoint.post("claim", "/pair", {
    payload: PairClaimRequest,
    success: PairClaimResult,
    error: [PairingCodeNotFound, PairingCodeSpent, PairingRateLimited],
  }),
);

export const MendApi = HttpApi.make("mend")
  .add(healthGroup)
  .add(machineGroup)
  .add(sealantGroup)
  .add(accountsGroup)
  .add(settingsGroup)
  .add(dotfilesGroup)
  .add(issuesGroup)
  .add(briefsGroup)
  .add(runsGroup)
  .add(projectsGroup)
  .add(gitKeysGroup)
  .add(projectEnvironmentGroup)
  .add(projectSecretsGroup)
  .add(projectMountsGroup)
  .add(projectRecipesGroup)
  .add(referencesGroup)
  .add(sessionsGroup)
  .add(sessionChangesGroup)
  .add(githubGroup)
  .add(devicesGroup)
  .add(userDevicesGroup)
  .add(pairGroup)
  .prefix("/api");
