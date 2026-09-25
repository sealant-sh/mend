import { ChangeId, ChangeLandingId, SessionGitOpId, SessionId, Sha, Timestamp } from "@mend/domain";
import { ChangeLanding, GitAuthMode, LandedPullRequest, LandingFact } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { StoreFailure } from "./workbench-views.ts";

// ─── Landing (docs/adr/0007-landing.md) ─────────────────────────────────────
// One push of a change's branch to origin, plus its pull request, recorded against a
// checkpoint. Only the change's owner lands; anyone who can see the project reads the record.

/** Land a session's change: `mend land <session> [--branch …] [--no-pr] [--title …]`. */
export class LandRequest extends Schema.Class<LandRequest>("LandRequest")({
  /**
   * The branch on origin; null keeps the one the change last pushed to, else `mend/<name>`.
   * Never the project's default branch or the pull request's base.
   */
  branch: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** False pushes only (`--no-pr`). */
  pullRequest: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** The owner's title; null opens with the session's label and keeps a title edited since. */
  title: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * The owner's own description, written above Mend's section; null keeps what people wrote on
   * GitHub and replaces only Mend's section.
   */
  body: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

/** How the pull request step went, beside the recorded landing. */
export const PullRequestStepView = Schema.Union([
  Schema.TaggedStruct("opened", { pullRequest: LandedPullRequest }),
  Schema.TaggedStruct("updated", { pullRequest: LandedPullRequest }),
  /** The owner turned it off for this landing. */
  Schema.TaggedStruct("off", {}),
  /** Origin is not on GitHub, or the project has none. */
  Schema.TaggedStruct("unavailable", { reason: Schema.String }),
  Schema.TaggedStruct("failed", { message: Schema.String }),
  /** An earlier step stopped the landing. */
  Schema.TaggedStruct("not-reached", {}),
]);
export type PullRequestStepView = typeof PullRequestStepView.Type;

export class LandingReportView extends Schema.Class<LandingReportView>("LandingReportView")({
  landing: ChangeLanding,
  pullRequest: PullRequestStepView,
}) {}

/** Origin's branch against the last landed commit, as one fetch observed it. */
export class RemoteBranchObservation extends Schema.Class<RemoteBranchObservation>(
  "RemoteBranchObservation",
)({
  remoteBranch: Schema.String,
  /** Origin's tip, or null when origin has no such branch. */
  remoteSha: Schema.NullOr(Sha),
  /** Commits on origin's branch that the landed commit lacks. */
  unseen: Schema.Int,
  /** Commits of the landed commit that origin's branch lacks; null when the branch is gone. */
  ahead: Schema.NullOr(Schema.Int),
  /** Origin's branch contains the landed commit. */
  holds: Schema.Boolean,
  observedAt: Timestamp,
}) {}

/** Whether a pull request can be opened from Mend for this project, and why not. */
export class PullRequestAvailabilityView extends Schema.Class<PullRequestAvailabilityView>(
  "PullRequestAvailabilityView",
)({
  available: Schema.Boolean,
  /** "pull request unavailable · origin is on gitlab.com, not GitHub"; null when available. */
  reason: Schema.NullOr(Schema.String),
}) {}

/** A change's landing record with the facts observed about it (the review page's Land panel). */
export class ChangeLandingsView extends Schema.Class<ChangeLandingsView>("ChangeLandingsView")({
  /** Null for a session whose worktree holds no change yet. */
  changeId: Schema.NullOr(ChangeId),
  /** The session a landing runs as: the change's session. */
  sessionId: Schema.NullOr(SessionId),
  /** Whether the caller may land it: they own the change (its worktree's first session). */
  land: Schema.Boolean,
  /** Newest first. */
  landings: Schema.Array(ChangeLanding),
  /** What Mend observed, in reading order; `landingFactLine` renders each. */
  facts: Schema.Array(LandingFact),
  /** Origin's branch, when the request asked for a fetch (`probe=true`) and one ran. */
  remote: Schema.NullOr(RemoteBranchObservation),
  /** Why the fetch could not run, in git's or the remote's words. */
  remoteFailure: Schema.NullOr(Schema.String),
  pullRequest: PullRequestAvailabilityView,
  /**
   * The branch the next landing pushes when the owner names none (`nextLandingBranch`): the last
   * landing's, the agent's own push, an adopted pull request's head on origin, else the
   * worktree's. Null for a change with no worktree yet, and from older servers.
   */
  nextBranch: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

/**
 * What "Check GitHub" found (docs/adr/0007-landing.md, "Pull requests opened outside Mend"):
 * `adopted` recorded a pull request opened outside Mend, `observed` refreshed one already
 * recorded, `none` found nothing, `skipped` did not look, and says why.
 */
export class PullRequestCheckView extends Schema.Class<PullRequestCheckView>(
  "PullRequestCheckView",
)({
  outcome: Schema.Literals(["adopted", "observed", "none", "skipped"]),
  reason: Schema.NullOr(Schema.String),
  landing: Schema.NullOr(ChangeLanding),
}) {}

export const GitTransportKindSchema = Schema.Literals(["fetch", "push", "archive"]);

/**
 * One remote git operation a session's workspace ran through Mend's transport (docs/
 * GIT-ACCESS.md). A push the agent made itself is here, with the refs it updated; it is not a
 * landing.
 */
export class SessionGitOpView extends Schema.Class<SessionGitOpView>("SessionGitOpView")({
  id: SessionGitOpId,
  sessionId: SessionId,
  host: Schema.String,
  port: Schema.NullOr(Schema.Int),
  kind: GitTransportKindSchema,
  command: Schema.String,
  authMode: GitAuthMode,
  /** `<old-sha> <new-sha> <ref>` per ref a push updated, when the transport saw them. */
  refUpdates: Schema.NullOr(Schema.Array(Schema.String)),
  /** Null while the operation runs, or when its end was lost to a restart. */
  exitCode: Schema.NullOr(Schema.Int),
  startedAt: Timestamp,
  finishedAt: Schema.NullOr(Timestamp),
}) {}

/** Only the change's owner lands: it pushes with their key and speaks as them on GitHub. */
export class LandingNotAllowed extends Schema.TaggedErrorClass<LandingNotAllowed>()(
  "LandingNotAllowed",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/**
 * The landing did not start, in its own words: the worktree holds no change, nothing is new since
 * the last landing, or the branch named is the default branch or the pull request's base.
 */
export class LandingNotStarted extends Schema.TaggedErrorClass<LandingNotStarted>()(
  "LandingNotStarted",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** `gh` or the platform could not answer for the pull request, in their words. */
export class PullRequestStepFailed extends Schema.TaggedErrorClass<PullRequestStepFailed>()(
  "PullRequestStepFailed",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

/** The change's bundle is over the instance's limit (`MEND_BUDGET_BUNDLE_BYTES`). */
export class BundleTooLarge extends Schema.TaggedErrorClass<BundleTooLarge>()(
  "BundleTooLarge",
  {
    /** The bundle's size in bytes. */
    size: Schema.Int,
    limit: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {}

/** A git bundle: `git fetch <file> refs/heads/<branch>` in a clone that has the session's base. */
export const ChangeBundleBytes = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "application/x-git-bundle" }),
);

/** Response headers the bundle carries, so `mend pull` needs no second request. */
export const BUNDLE_HEADERS = {
  branch: "x-mend-bundle-branch",
  base: "x-mend-bundle-base",
  tip: "x-mend-bundle-tip",
  commits: "x-mend-bundle-commits",
};

const probeQuery = { probe: Schema.optional(Schema.Literals(["true", "false"])) };

export const landingsGroup = HttpApiGroup.make("landings")
  .add(
    HttpApiEndpoint.post("land", "/sessions/:id/land", {
      params: { id: SessionId },
      payload: LandRequest,
      success: LandingReportView,
      // An ARRAY, not Schema.Union: the union collapses per-member httpApiStatus to 500.
      error: [NotFound, LandingNotAllowed, LandingNotStarted],
    }),
  )
  .add(
    HttpApiEndpoint.get("forSession", "/sessions/:id/landings", {
      params: { id: SessionId },
      query: probeQuery,
      success: ChangeLandingsView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("forChange", "/changes/:id/landings", {
      params: { id: ChangeId },
      query: probeQuery,
      success: ChangeLandingsView,
      error: NotFound,
    }),
  )
  .add(
    // Ask `gh`, as the change's owner, for a pull request someone opened outside Mend for the
    // change's branches or the agent's commit, and record it. The owner only.
    HttpApiEndpoint.post("checkGitHub", "/changes/:id/pull-request/check", {
      params: { id: ChangeId },
      success: PullRequestCheckView,
      error: [NotFound, LandingNotAllowed, PullRequestStepFailed],
    }),
  )
  .add(
    // Ask `gh` for the pull request's state now; Mend does not poll GitHub.
    HttpApiEndpoint.post("refresh", "/landings/:id/refresh", {
      params: { id: ChangeLandingId },
      success: ChangeLanding,
      error: [NotFound, LandingNotAllowed, PullRequestStepFailed],
    }),
  )
  .add(
    // `mend pull`: the commits from the session's base to its latest checkpoint, committed as
    // a landing's step 2 does, never pushed. Authorized like the review diff.
    HttpApiEndpoint.get("bundle", "/changes/:id/bundle", {
      params: { id: ChangeId },
      success: ChangeBundleBytes,
      error: [NotFound, StoreFailure, BundleTooLarge],
    }),
  )
  .add(
    HttpApiEndpoint.get("gitOps", "/sessions/:id/git-ops", {
      params: { id: SessionId },
      success: Schema.Array(SessionGitOpView),
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);
