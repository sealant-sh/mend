import {
  ChangeId,
  MendSettings,
  DotfilesRepository,
  WorkspaceImage,
  WorktreeId,
} from "@mend/domain";
import { Timestamp } from "@mend/domain";
import {
  AutomationChoice,
  GitAuthMode,
  Project,
  RepositoryCloneUrl,
  Session,
  SessionProcess,
  Worktree,
} from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

// ─── Workbench (MEND-AGENT-WORKBENCH-PLAN.md §5–§7) ─────────────────────────

/**
 * Where the bytes of a change read came from (docs/adr/0002-session-capture-store.md "Review"):
 * the live worktree beside Mend, or a registered capture — stamped, never judged. `claimed` is
 * a summary the executor posted and no runner has recomputed yet; `observed` was computed or
 * recomputed by Mend. `partial` marks an `auto` capture, which is not atomic across files.
 * `label` is the terse line the UI renders: "observed at capture 12 · seq 4180".
 */
export class ObservationStamp extends Schema.Class<ObservationStamp>("ObservationStamp")({
  state: Schema.Literals(["claimed", "observed"]),
  source: Schema.Literals(["worktree", "capture"]),
  captureN: Schema.NullOr(Schema.Int),
  captureId: Schema.NullOr(Schema.String),
  seq: Schema.NullOr(Schema.String),
  partial: Schema.Boolean,
  label: Schema.String,
}) {}

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
 * Adoption: clone one network Git URL into the store under `name`.
 * Omitted `gitAuthMode` means `ambient` (the login user's git setup).
 */
export class AdoptProject extends Schema.Class<AdoptProject>("AdoptProject")({
  name: Schema.String,
  source: RepositoryCloneUrl,
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

/**
 * List decoration for one worktree — the container's DB-cheap facts. Same
 * discipline as SessionAnnotation: no git for a list; diff stats stay behind
 * /changes/:id/stats.
 */
export class WorktreeAnnotation extends Schema.Class<WorktreeAnnotation>("WorktreeAnnotation")({
  worktreeId: WorktreeId,
  changeId: Schema.NullOr(ChangeId),
  /** Conversations in the worktree — all, and currently live. */
  sessions: Schema.Int,
  liveSessions: Schema.Int,
  openComments: Schema.Int,
  totalComments: Schema.Int,
  pendingFollowUp: Schema.Boolean,
  /** Newest live agent process across the worktree's sessions, else newest ever; null before any launch. */
  currentAgent: Schema.NullOr(SessionProcess),
}) {}

export class ProjectDetail extends Schema.Class<ProjectDetail>("ProjectDetail")({
  project: Project,
  sessions: Schema.Array(Session),
  /** Kept per session while pre-worktree clients read it; same facts as the worktree's. */
  annotations: Schema.Array(SessionAnnotation),
  /**
   * The project's worktree containers, embedded so lists never need a second
   * fetch. Clients detect the worktree-aware server by this key's presence.
   */
  worktrees: Schema.Array(Worktree),
  worktreeAnnotations: Schema.Array(WorktreeAnnotation),
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

/** The project's stance on the cascade switches — all of them, replaced together. */
export class ProjectAutomationRequest extends Schema.Class<ProjectAutomationRequest>(
  "ProjectAutomationRequest",
)({
  autoTour: AutomationChoice,
  autoSuggest: AutomationChoice,
  autoName: AutomationChoice,
  /** Older clients omit the key — decode to `inherit` so they cannot clobber the stance. */
  backgroundSessions: AutomationChoice.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("inherit" as const)),
  ),
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

/** Whether sessions inherit the launching user's skills in addition to project skills. */
export class ProjectInheritUserSkillsRequest extends Schema.Class<ProjectInheritUserSkillsRequest>(
  "ProjectInheritUserSkillsRequest",
)({
  inheritUserSkills: Schema.Boolean,
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
  committedAt: Timestamp,
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
  since: Schema.NullOr(Timestamp),
}) {}

/** The user-level git access choice; `ambient` stays a per-project mode. */
export const GitAccessMode = Schema.Literals(["mend-key", "bridge"]);
export type GitAccessMode = typeof GitAccessMode.Type;

/**
 * How the calling user's remotes are reached by default: the mode, their Mend key (public
 * half; exists=false until created), and the bridge's presence. New projects adopt with the
 * mode; the CLI shares the machine's agent only while the mode is bridge.
 */
export class GitAccessView extends Schema.Class<GitAccessView>("GitAccessView")({
  mode: GitAccessMode,
  key: GitKeyView,
  bridge: GitBridgeStatusView,
}) {}

export class SetGitAccessRequest extends Schema.Class<SetGitAccessRequest>("SetGitAccessRequest")({
  mode: GitAccessMode,
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
