import {
  ChangeLandingsRepo,
  ChangeToursRepo,
  type LandingResult,
  ProjectsRepo,
  SessionsRepo,
  UsersRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ChangeLandingId, SessionId, Sha } from "@mend/domain";
import type {
  ChangeLanding,
  Checkpoint,
  CheckpointTrigger,
  LandedPullRequest,
  LandingTrigger,
  Project,
  Session,
  Worktree,
} from "@mend/domain/workbench";
import type { DiffFileFact, LandingAuthor, Pushed, PushRefusedError } from "@mend/store";
import { Effect, Layer, Result, Schema } from "effect";
import * as Context from "effect/Context";

import {
  describedFileOf,
  describePullRequest,
  landingCommitMessage,
  pullRequestTitle,
} from "./description.ts";
import { pullRequestAvailability, pullRequestBase } from "./github.ts";
import { PullRequests, PullRequestStepError } from "./pull-requests.ts";

/**
 * Landing a change (docs/adr/0007-landing.md, "One action: land"): take a checkpoint, commit what
 * the agent left uncommitted, push the branch to origin, and open or update the pull request,
 * stopping at the first step that fails. Every attempt that starts is recorded as a
 * `change_landings` row with its outcome and, when it did not finish, the words of whatever
 * stopped it. Nothing retries.
 *
 * Only the session's owner lands: the push signs with their key and the pull request speaks as
 * them on GitHub. Callers that serve other people refuse before calling here, and `land` checks
 * again.
 */

// ─── The git half, per store kind ───────────────────────────────────────────

/** A step of the git half that did not finish, in git's words or the remote's. */
export class LandingStepError extends Schema.TaggedErrorClass<LandingStepError>()(
  "LandingStepError",
  {
    step: Schema.Literals(["checkpoint", "commit", "push", "files"]),
    message: Schema.String,
  },
) {}

/** What a landing acts on, resolved once. */
export interface LandingScope {
  readonly session: Session;
  readonly project: Project;
  readonly worktree: Worktree;
}

/**
 * Steps 1 to 3, where the worktree's authority is: the project store for a co-located session,
 * the runner cache for a capture-backed one (ADR 0002). Each runs on the host, never in an
 * executor.
 */
export class LandingGit extends Context.Service<
  LandingGit,
  {
    /**
     * Step 1: a checkpoint of what the worktree holds now, with the session branch's head as it
     * was just before, which step 2 parents on and guards against moving.
     */
    readonly checkpoint: (
      scope: LandingScope,
      trigger: CheckpointTrigger,
    ) => Effect.Effect<
      { readonly checkpoint: Checkpoint; readonly branchHead: Sha },
      LandingStepError
    >;
    /**
     * Step 2: a commit of the checkpoint's tree on the branch head when it differs, by the owner.
     * `head` is what step 3 pushes; `commitSha` is null when the agent's commits already hold it.
     */
    readonly commit: (
      scope: LandingScope,
      input: {
        readonly checkpoint: Checkpoint;
        readonly branchHead: Sha;
        readonly author: LandingAuthor;
        readonly message: string;
      },
    ) => Effect.Effect<{ readonly head: Sha; readonly commitSha: Sha | null }, LandingStepError>;
    /** Step 3: a fast-forward-only push; a refusal is typed and in the remote's words. */
    readonly push: (
      scope: LandingScope,
      input: {
        readonly sha: Sha;
        readonly remoteBranch: string;
        readonly remoteEnv: Readonly<Record<string, string>>;
      },
    ) => Effect.Effect<Pushed, PushRefusedError | LandingStepError>;
    /** The landed range's files with their line counts, for the description. */
    readonly changedFiles: (
      scope: LandingScope,
      input: { readonly base: Sha; readonly head: Sha },
    ) => Effect.Effect<ReadonlyArray<DiffFileFact>, LandingStepError>;
  }
>()("@mend/landing/LandingGit") {}

// ─── The service ────────────────────────────────────────────────────────────

/** Why a landing did not start. Nothing is recorded: no attempt was made. */
export class LandingNotStartedError extends Schema.TaggedErrorClass<LandingNotStartedError>()(
  "LandingNotStartedError",
  {
    reason: Schema.Literals(["not-found", "no-owner", "not-owner", "no-change"]),
    message: Schema.String,
  },
) {}

export interface LandInput {
  readonly sessionId: SessionId;
  /** Who asked. Only the session's owner lands. */
  readonly actorUserId: string;
  readonly trigger: LandingTrigger;
  /** The branch on origin. Null keeps the branch the change landed on before, else the session's. */
  readonly remoteBranch: string | null;
  /** False skips step 4, as `mend land --no-pr` does. */
  readonly pullRequest: boolean;
  /** The owner's own title. Null opens with the session's label and keeps a title edited since. */
  readonly title: string | null;
  /** The web origin the description's and the commit's links are built from; null writes none. */
  readonly webOrigin: string | null;
  /**
   * The env step 3 authenticates with: the project's `gitAuthMode` for the owner, pinned by the
   * caller's source policy. Resolved only when the landing reaches the push.
   */
  readonly remoteEnv: Effect.Effect<Readonly<Record<string, string>>, LandingStepError>;
}

/** How step 4 went, beside the recorded row. */
export type PullRequestStep =
  | { readonly _tag: "opened"; readonly pullRequest: LandedPullRequest }
  | { readonly _tag: "updated"; readonly pullRequest: LandedPullRequest }
  /** The owner turned it off for this landing. */
  | { readonly _tag: "off" }
  /** Origin is not on GitHub, or the project has none. */
  | { readonly _tag: "unavailable"; readonly reason: string }
  | { readonly _tag: "failed"; readonly message: string }
  /** An earlier step stopped the landing. */
  | { readonly _tag: "not-reached" };

export interface LandingReport {
  readonly landing: ChangeLanding;
  readonly pullRequest: PullRequestStep;
}

export class Landing extends Context.Service<
  Landing,
  {
    readonly land: (input: LandInput) => Effect.Effect<LandingReport, LandingNotStartedError>;
    /**
     * Ask `gh` for the landing's pull request now and record what it said. A landing with no pull
     * request comes back unchanged.
     */
    readonly refreshPullRequest: (
      landingId: ChangeLandingId,
    ) => Effect.Effect<ChangeLanding, LandingNotStartedError | PullRequestStepError>;
  }
>()("@mend/landing/Landing") {}

// ─── Links ──────────────────────────────────────────────────────────────────

const originOf = (webOrigin: string) => webOrigin.replace(/\/+$/, "");

export const sessionLink = (webOrigin: string, sessionId: string): string =>
  `${originOf(webOrigin)}/sessions/${encodeURIComponent(sessionId)}`;

export const reviewLink = (webOrigin: string, changeId: string): string =>
  `${originOf(webOrigin)}/changes/${encodeURIComponent(changeId)}`;

/** The session page lists its checkpoints; the fragment names the landed one. */
export const checkpointLink = (webOrigin: string, sessionId: string, ordinal: number): string =>
  `${sessionLink(webOrigin, sessionId)}#checkpoint-${ordinal}`;

// ─── Live ───────────────────────────────────────────────────────────────────

const notStarted = (reason: LandingNotStartedError["reason"], message: string) =>
  new LandingNotStartedError({ reason, message });

/** A diverged refusal says what the probe counted before the remote's own words. */
const refusalWords = (error: PushRefusedError): string =>
  error.reason === "diverged" && error.unseen !== null
    ? `origin has moved · ${error.remoteBranch} has ${error.unseen} ${error.unseen === 1 ? "commit" : "commits"} Mend has not seen · ${error.message}`
    : error.message;

export const LandingLive: Layer.Layer<
  Landing,
  never,
  | SessionsRepo
  | ProjectsRepo
  | WorktreesRepo
  | WorktreeChangesRepo
  | ChangeLandingsRepo
  | ChangeToursRepo
  | UsersRepo
  | LandingGit
  | PullRequests
> = Layer.effect(
  Landing,
  Effect.gen(function* () {
    const sessions = yield* SessionsRepo;
    const projects = yield* ProjectsRepo;
    const worktrees = yield* WorktreesRepo;
    const changes = yield* WorktreeChangesRepo;
    const landings = yield* ChangeLandingsRepo;
    const tours = yield* ChangeToursRepo;
    const users = yield* UsersRepo;
    const git = yield* LandingGit;
    const pullRequests = yield* PullRequests;

    const scopeOf = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const session = yield* sessions.byId(sessionId);
        const project = yield* projects.byId(session.projectId);
        const worktree = yield* worktrees.byId(session.worktreeId);
        return { session, project, worktree } satisfies LandingScope;
      }).pipe(
        Effect.mapError((error) =>
          notStarted("not-found", `landing not started · ${error._tag} · ${sessionId}`),
        ),
      );

    const land = Effect.fn("Landing.land")(function* (input: LandInput) {
      const scope = yield* scopeOf(input.sessionId);
      const { session, project, worktree } = scope;
      const owner = session.ownerUserId;
      if (owner === null) {
        return yield* notStarted("no-owner", "landing not started · the session has no owner");
      }
      if (owner !== input.actorUserId) {
        return yield* notStarted(
          "not-owner",
          "landing not started · only the session's owner lands its change",
        );
      }
      const change = yield* changes.byWorktree(worktree.id);
      if (change === null) {
        return yield* notStarted("no-change", "landing not started · the session has no change");
      }
      const history = yield* landings.listForChange(change.id);
      const remoteBranch = input.remoteBranch ?? history[0]?.remoteBranch ?? worktree.branch;

      const finish = (
        checkpoint: Checkpoint | null,
        commitSha: Sha | null,
        result: LandingResult,
        pullRequest: PullRequestStep,
      ) =>
        landings
          .record({
            changeId: change.id,
            sessionId: session.id,
            projectId: project.id,
            checkpoint:
              checkpoint === null
                ? null
                : { id: checkpoint.id, ref: checkpoint.ref, sha: checkpoint.sha },
            commitSha,
            remoteBranch,
            trigger: input.trigger,
            userId: owner,
            result,
          })
          .pipe(Effect.map((landing): LandingReport => ({ landing, pullRequest })));
      const failed = (checkpoint: Checkpoint | null, commitSha: Sha | null, message: string) =>
        finish(
          checkpoint,
          commitSha,
          { outcome: "failed", pushedSha: null, message },
          { _tag: "not-reached" },
        );

      // 1. Checkpoint: what the worktree holds now, as a recorded object.
      const taken = yield* git
        .checkpoint(scope, input.trigger === "manual" ? "user-mark" : "turn-boundary")
        .pipe(Effect.result);
      if (Result.isFailure(taken)) return yield* failed(null, null, taken.failure.message);
      const { checkpoint, branchHead } = taken.success;

      // 2. Commit what the agent left uncommitted, as the owner.
      const author = yield* users.byId(owner);
      if (author === null) {
        return yield* failed(checkpoint, null, "the owner's account no longer exists");
      }
      const tour = yield* tours.byChange(change.id);
      const links =
        input.webOrigin === null
          ? { session: null, review: null, checkpoint: null }
          : {
              session: sessionLink(input.webOrigin, session.id),
              review: reviewLink(input.webOrigin, change.id),
              checkpoint: checkpointLink(input.webOrigin, session.id, checkpoint.ordinal),
            };
      const committed = yield* git
        .commit(scope, {
          checkpoint,
          branchHead,
          author: { name: author.name, email: author.email },
          message: landingCommitMessage({
            tourSummary: tour?.summary ?? null,
            label: session.label,
            sessionId: session.id,
            sessionUrl: links.session,
          }),
        })
        .pipe(Effect.result);
      if (Result.isFailure(committed)) {
        return yield* failed(checkpoint, null, committed.failure.message);
      }
      const { head, commitSha } = committed.success;

      // 3. Push, fast-forward only.
      const pushed = yield* input.remoteEnv.pipe(
        Effect.flatMap((remoteEnv) => git.push(scope, { sha: head, remoteBranch, remoteEnv })),
        Effect.result,
      );
      if (Result.isFailure(pushed)) {
        const error = pushed.failure;
        return yield* error._tag === "PushRefusedError"
          ? finish(
              checkpoint,
              commitSha,
              { outcome: "refused", message: refusalWords(error) },
              { _tag: "not-reached" },
            )
          : failed(checkpoint, commitSha, error.message);
      }
      const pushedSha = pushed.success.pushedSha;
      const pushedOnly = (step: PullRequestStep) =>
        finish(checkpoint, commitSha, { outcome: "pushed", pushedSha }, step);

      // 4. The pull request, when asked for and origin is on GitHub.
      if (!input.pullRequest) return yield* pushedOnly({ _tag: "off" });
      const availability = pullRequestAvailability(project.originUrl);
      if (!availability.available) {
        return yield* pushedOnly({ _tag: "unavailable", reason: availability.reason });
      }
      const files = yield* git
        .changedFiles(scope, { base: worktree.baseSha, head: pushedSha })
        .pipe(
          Effect.map((facts) => facts.map(describedFileOf)),
          Effect.catch((error) =>
            Effect.logWarning("landing: the landed files could not be listed").pipe(
              Effect.annotateLogs({ sessionId: session.id, error: error.message }),
              Effect.as(null),
            ),
          ),
        );
      const previous = history.find((landing) => landing.pullRequest !== null)?.pullRequest ?? null;
      const published = yield* pullRequests
        .publish({
          target: { ownerUserId: owner, sessionId: session.id },
          repository: availability.repository,
          head: remoteBranch,
          base: pullRequestBase(worktree.baseRef, project.defaultBranch),
          title: pullRequestTitle({
            explicit: input.title,
            label: session.label,
            sessionId: session.id,
          }),
          titleGiven: input.title !== null && input.title.trim() !== "",
          section: describePullRequest({
            tour: tour === null ? null : { summary: tour.summary, approach: tour.approach },
            files,
            checks: [],
            checkpoint: { ordinal: checkpoint.ordinal, sha: checkpoint.sha },
            links,
          }),
          previous: previous?.number ?? null,
        })
        .pipe(Effect.result);
      if (Result.isFailure(published)) {
        const message = published.failure.message;
        return yield* finish(
          checkpoint,
          commitSha,
          { outcome: "failed", pushedSha, message },
          { _tag: "failed", message },
        );
      }
      const { action, pullRequest } = published.success;
      return yield* finish(
        checkpoint,
        commitSha,
        { outcome: "pull-request", pushedSha, pullRequest },
        { _tag: action, pullRequest },
      );
    });

    const refreshPullRequest = Effect.fn("Landing.refreshPullRequest")(function* (
      landingId: ChangeLandingId,
    ) {
      const landing = yield* landings.byId(landingId);
      if (landing === null) {
        return yield* notStarted("not-found", `no landing ${landingId}`);
      }
      if (landing.pullRequest === null) return landing;
      const project = yield* projects
        .byId(landing.projectId)
        .pipe(Effect.mapError(() => notStarted("not-found", `no project ${landing.projectId}`)));
      const availability = pullRequestAvailability(project.originUrl);
      if (!availability.available) {
        return yield* new PullRequestStepError({ message: availability.reason });
      }
      const observed = yield* pullRequests.observe({
        target: { ownerUserId: landing.userId, sessionId: landing.sessionId },
        repository: availability.repository,
        number: landing.pullRequest.number,
      });
      const updated = yield* landings.observePullRequest(landing.id, observed);
      return updated ?? landing;
    });

    return { land, refreshPullRequest };
  }),
);
