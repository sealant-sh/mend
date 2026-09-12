import { MendSettings, WorkspaceImage } from "@mend/domain";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware } from "./common.ts";
import { DotfilesRepositoryRequest, ObservationStamp } from "./workbench-views.ts";
import {
  DotfilesSnapshotRequest,
  DotfilesView,
  HostEnvironmentSuggestionsView,
  SettingsFailure,
  WorkspaceEnvironmentSaveResult,
} from "./workbench-views.ts";

export const settingsGroup = HttpApiGroup.make("settings")
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
export const dotfilesGroup = HttpApiGroup.make("dotfiles")
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
  /** Capture mode: the capture the listing was read from; absent for a branch tree. */
  observation: Schema.optionalKey(ObservationStamp),
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
