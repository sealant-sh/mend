import {
  ProjectLinkId,
  ProjectId,
  ProjectMountId,
  ReferenceId,
  SessionId,
  WorktreeId,
} from "@mend/domain";
import {
  ProjectLink,
  Project,
  ProjectEnvironmentVariable,
  ProjectMount,
  Reference,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { ProjectFileListing, ProjectPullRequests } from "./settings.ts";
import {
  AdoptProject,
  GitAccessView,
  GitAuthorView,
  GitBridgeStatusView,
  GitKeyView,
  SetGitAccessRequest,
  SetGitAuthorRequest,
  ProjectApplyDotfilesRequest,
  ProjectDefaultShellProfileRequest,
  ProjectAutomationRequest,
  ProjectDetail,
  ProjectVisibilityRequest,
  ProjectGitAuthRequest,
  ProjectHotSessionsRequest,
  ProjectInstallCommandRequest,
  ProjectInheritUserSkillsRequest,
  ProjectHotSessionsStatus,
  ProjectWorkspaceImageRequest,
  ProjectWorkspaceImageSaveResult,
  RemovalReport,
  SettingsFailure,
  StoreFailure,
} from "./workbench-views.ts";

/** One branch a session can base on — origin's view merged with local-only heads. */
export class ProjectBranch extends Schema.Class<ProjectBranch>("ProjectBranch")({
  /** Short branch name (`main`, `yiannisp/refactor`) — never a session branch. */
  name: Schema.String,
  sha: Schema.String,
  /** Committer date of the tip, ISO 8601. */
  committedAt: Schema.String,
  isDefault: Schema.Boolean,
}) {}

export const projectsGroup = HttpApiGroup.make("projects")
  .add(HttpApiEndpoint.get("list", "/projects", { success: Schema.Array(Project) }))
  .add(
    HttpApiEndpoint.post("adopt", "/projects", {
      payload: AdoptProject,
      success: Project,
      error: StoreFailure,
    }),
  )
  .add(
    // Settled sessions without a captured transcript are left out unless asked for.
    // ProjectDetail reports how many this response omitted, so the capture gap stays visible.
    HttpApiEndpoint.get("detail", "/projects/:id", {
      params: { id: ProjectId },
      query: { deadEnds: Schema.optional(Schema.Literals(["include"])) },
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
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Owners only (docs/adr/0003); anyone else gets the same 404 as a missing project.
    HttpApiEndpoint.put("visibility", "/projects/:id/visibility", {
      params: { id: ProjectId },
      payload: ProjectVisibilityRequest,
      success: Project,
      error: NotFound,
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
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.put("workspaceImage", "/projects/:id/workspace-image", {
      params: { id: ProjectId },
      payload: ProjectWorkspaceImageRequest,
      success: ProjectWorkspaceImageSaveResult,
      error: [NotFound, SettingsFailure],
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
    HttpApiEndpoint.put("defaultShellProfile", "/projects/:id/default-shell-profile", {
      params: { id: ProjectId },
      payload: ProjectDefaultShellProfileRequest,
      success: Project,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.put("inheritUserSkills", "/projects/:id/inherit-user-skills", {
      params: { id: ProjectId },
      payload: ProjectInheritUserSkillsRequest,
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
    HttpApiEndpoint.put("installCommand", "/projects/:id/install-command", {
      params: { id: ProjectId },
      payload: ProjectInstallCommandRequest,
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
    // What the store holds right now — no fetch. The composer's branch picker reads this.
    HttpApiEndpoint.get("branches", "/projects/:id/branches", {
      params: { id: ProjectId },
      success: Schema.Array(ProjectBranch),
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // Fetch every origin branch into the store (heads + remote-tracking, never pruned),
    // then answer with the refreshed listing — one call serves "refresh" buttons everywhere.
    HttpApiEndpoint.post("refresh", "/projects/:id/refresh", {
      params: { id: ProjectId },
      success: Schema.Array(ProjectBranch),
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    // `?worktree=` roots the listing at that worktree; `?session=` resolves
    // through the session's worktree (pre-worktree clients); `worktree` wins
    // when both are sent. Absent both, the default branch's tree in the bare
    // store. Ids from another project answer 404.
    HttpApiEndpoint.get("files", "/projects/:id/files", {
      params: { id: ProjectId },
      query: { session: Schema.optional(SessionId), worktree: Schema.optional(WorktreeId) },
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
 * The calling user's Mend git key (docs/GIT-ACCESS.md): GET reads; POST
 * generates on first use ("mend keys init"). One key per user, held on the
 * server. `/me/git-access` is the user's default: which of their key or
 * their own machine (bridge) signs.
 */
export const gitKeysGroup = HttpApiGroup.make("gitKeys")
  .add(HttpApiEndpoint.get("show", "/keys/git", { success: GitKeyView }))
  .add(HttpApiEndpoint.post("init", "/keys/git", { success: GitKeyView, error: StoreFailure }))
  .add(HttpApiEndpoint.get("bridgeStatus", "/keys/bridge", { success: GitBridgeStatusView }))
  .add(HttpApiEndpoint.get("access", "/me/git-access", { success: GitAccessView }))
  .add(
    HttpApiEndpoint.put("setAccess", "/me/git-access", {
      payload: SetGitAccessRequest,
      success: GitAccessView,
      error: StoreFailure,
    }),
  )
  // The name and email this account's workspaces commit as; DELETE returns it to the account's
  // registration name and email (docs/GIT-ACCESS.md, "Git author").
  .add(HttpApiEndpoint.get("author", "/me/git-author", { success: GitAuthorView }))
  .add(
    HttpApiEndpoint.put("setAuthor", "/me/git-author", {
      payload: SetGitAuthorRequest,
      success: GitAuthorView,
      error: SettingsFailure,
    }),
  )
  .add(HttpApiEndpoint.delete("clearAuthor", "/me/git-author", { success: GitAuthorView }))
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
export const referencesGroup = HttpApiGroup.make("references")
  .add(HttpApiEndpoint.get("list", "/references", { success: Schema.Array(Reference) }))
  .add(
    HttpApiEndpoint.post("add", "/references", {
      payload: AddReference,
      success: Reference,
      error: [StoreFailure, NotFound],
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
      error: [NotFound, StoreFailure],
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

/**
 * Link another adopted project (ADR-0001): its named worktree is bound read-write at
 * `/workspace/repos/<name>` in this project's sessions. A null worktree name picks — creating it
 * if needed — the linked project's worktree named after its default branch.
 */
export class AddProjectLink extends Schema.Class<AddProjectLink>("AddProjectLink")({
  linkedProjectId: ProjectId,
  name: Schema.String,
  worktreeName: Schema.NullOr(Schema.String),
}) {}

export const projectLinksGroup = HttpApiGroup.make("projectLinks")
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/links", {
      params: { id: ProjectId },
      success: Schema.Array(ProjectLink),
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("add", "/projects/:id/links", {
      params: { id: ProjectId },
      payload: AddProjectLink,
      success: ProjectLink,
      error: [NotFound, StoreFailure],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/links/:linkId", {
      params: { id: ProjectId, linkId: ProjectLinkId },
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
export const projectMountsGroup = HttpApiGroup.make("projectMounts")
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
      error: [NotFound, StoreFailure],
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
