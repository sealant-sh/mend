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
import {
  type ChangeLanding,
  changeOwnerOf,
  type Checkpoint,
  type CheckpointTrigger,
  type LandedPullRequest,
  type LandingTrigger,
  type Project,
  type Session,
  type Worktree,
} from "@mend/domain/workbench";
import type {
  BundleEmptyError,
  BundleTooLargeError,
  ChangeBundle,
  DiffFileFact,
  LandingAuthor,
  Pushed,
  PushRefusedError,
  RemoteBranchState,
} from "@mend/store";
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
 * Only the change's owner lands (`changeOwnerOf`: the owner of the worktree's first session), not
 * whoever owns the session that asked: the push signs with their key, Mend's commit is theirs, and
 * the pull request speaks as them on GitHub. Callers that serve other people refuse before
 * calling here, and `land` checks again.
 */

// ─── The git half, per store kind ───────────────────────────────────────────

/** A step of the git half that did not finish, in git's words or the remote's. */
export class LandingStepError extends Schema.TaggedErrorClass<LandingStepError>()(
  "LandingStepError",
  {
    step: Schema.Literals(["checkpoint", "commit", "push", "files", "probe", "bundle"]),
    message: Schema.String,
  },
) {}

/** Where a change lives: its project and worktree. */
export interface LandingPlace {
  readonly project: Project;
  readonly worktree: Worktree;
}

/** What a landing acts on, resolved once. */
export interface LandingScope extends LandingPlace {
  readonly session: Session;
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
     * Step 1: a checkpoint of what the worktree holds now, with the agent's branch head as the
     * checkpoint saw it (H), which step 2 parents on. The branch itself is never moved.
     */
    readonly checkpoint: (
      scope: LandingScope,
      trigger: CheckpointTrigger,
    ) => Effect.Effect<
      { readonly checkpoint: Checkpoint; readonly agentHead: Sha },
      LandingStepError
    >;
    /**
     * The latest checkpoint the worktree already has, and the agent's head as of it, without
     * taking one: what someone other than the change's owner pulls, so pulling adds nothing to
     * the owner's record. Null when the worktree has no checkpoint yet.
     */
    readonly latest: (
      scope: LandingScope,
    ) => Effect.Effect<
      { readonly checkpoint: Checkpoint | null; readonly agentHead: Sha },
      LandingStepError
    >;
    /**
     * Step 2: Mend's commit of the checkpoint's tree, by the change's owner, parented on the last
     * landing (L) and the agent's head (H) by `planLanding`, and kept under
     * `refs/mend/landed/<worktree>`. `head` is what step 3 pushes; `commitSha` is null when an
     * existing commit already is what lands; `nothingNew` says the last landing already pushed it.
     */
    readonly commit: (
      scope: LandingScope,
      input: {
        readonly checkpoint: Checkpoint;
        readonly agentHead: Sha;
        readonly lastLanded: Sha | null;
        readonly author: LandingAuthor;
        readonly message: string;
        /**
         * Keep the head under `refs/mend/landed/<worktree>` (a landing). False keeps nothing: a
         * bundle's commit lives only in the bundle.
         */
        readonly keep: boolean;
      },
    ) => Effect.Effect<
      { readonly head: Sha; readonly commitSha: Sha | null; readonly nothingNew: boolean },
      LandingStepError
    >;
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
    /**
     * Origin's branch against a landed commit, as a fetch observes it: "origin has moved" and
     * "the landed commit is on origin". Nothing is written to the store or the cache.
     */
    readonly probe: (
      place: LandingPlace,
      input: {
        readonly sha: Sha;
        readonly remoteBranch: string;
        readonly remoteEnv: Readonly<Record<string, string>>;
      },
    ) => Effect.Effect<RemoteBranchState, LandingStepError>;
    /** The `mend pull` bundle of `base..tip`, naming the branch; refused over the limit. */
    readonly bundle: (
      scope: LandingScope,
      input: {
        readonly base: Sha;
        readonly tip: Sha;
        readonly branch: string;
        readonly limitBytes: number;
      },
    ) => Effect.Effect<ChangeBundle, LandingStepError | BundleTooLargeError | BundleEmptyError>;
  }
>()("@mend/landing/LandingGit") {}

// ─── The service ────────────────────────────────────────────────────────────

/** Why a landing did not start. Nothing is recorded: no attempt was made. */
export class LandingNotStartedError extends Schema.TaggedErrorClass<LandingNotStartedError>()(
  "LandingNotStartedError",
  {
    reason: Schema.Literals([
      "not-found",
      "no-owner",
      "not-owner",
      "no-change",
      /** The branch named is the project's default branch or the pull request's base. */
      "branch",
      /** The worktree and the agent's branch hold nothing the last landing did not push. */
      "nothing-new",
    ]),
    message: Schema.String,
  },
) {}

export interface LandInput {
  readonly sessionId: SessionId;
  /** Who asked. Only the change's owner lands. */
  readonly actorUserId: string;
  readonly trigger: LandingTrigger;
  /**
   * The branch on origin. Null keeps the branch the change last pushed to, else the session's.
   * Never the project's default branch or the pull request's base.
   */
  readonly remoteBranch: string | null;
  /** False skips step 4, as `mend land --no-pr` does. */
  readonly pullRequest: boolean;
  /** The owner's own title. Null opens with the session's label and keeps a title edited since. */
  readonly title: string | null;
  /**
   * The owner's own words for the description, written above Mend's section in place of
   * whatever sat outside it. Null keeps what people wrote on GitHub and replaces only the
   * section.
   */
  readonly body: string | null;
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

/** A `mend pull` bundle of a session's change (docs/adr/0007-landing.md, "Pulling a change"). */
export interface BundleChangeInput {
  readonly sessionId: SessionId;
  /**
   * Who asked. Only the change's owner gets a fresh checkpoint; anyone else the latest one. The
   * commit Mend writes for leftovers is by the change's owner, or by the asker when it has none.
   */
  readonly actorUserId: string;
  readonly webOrigin: string | null;
  /** The largest bundle handed back; a larger one is refused with its size. */
  readonly limitBytes: number;
}

export class Landing extends Context.Service<
  Landing,
  {
    readonly land: (input: LandInput) => Effect.Effect<LandingReport, LandingNotStartedError>;
    /**
     * Commit the leftovers exactly as a landing's step 2 does, without pushing, and bundle the
     * commits from the session's base to that head. No side effects on the owner's history: no
     * branch moves, no ref is written, and only the change's owner gets a checkpoint taken; anyone
     * else gets the latest one that exists. Nothing is recorded as a landing.
     */
    readonly bundle: (
      input: BundleChangeInput,
    ) => Effect.Effect<
      ChangeBundle,
      LandingNotStartedError | LandingStepError | BundleTooLargeError | BundleEmptyError
    >;
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

const linksOf = (webOrigin: string | null, sessionId: string, changeId: string, ordinal: number) =>
  webOrigin === null
    ? { session: null, review: null, checkpoint: null }
    : {
        session: sessionLink(webOrigin, sessionId),
        review: reviewLink(webOrigin, changeId),
        checkpoint: checkpointLink(webOrigin, sessionId, ordinal),
      };

// ─── Live ───────────────────────────────────────────────────────────────────

const notStarted = (reason: LandingNotStartedError["reason"], message: string) =>
  new LandingNotStartedError({ reason, message });

/** Where the pull request step runs `gh`: the session's workspace only when it is the owner's. */
const workspaceTarget = (session: Session, owner: string) => ({
  ownerUserId: owner,
  sessionId: session.ownerUserId === owner ? session.id : null,
});

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

    /** Step 2: the checkpoint's tree as the owner's commit on the branch head, when it differs. */
    const commitWork = (
      scope: LandingScope,
      input: {
        readonly checkpoint: Checkpoint;
        readonly agentHead: Sha;
        readonly lastLanded: Sha | null;
        readonly keep: boolean;
        readonly authorUserId: string;
        readonly tourSummary: string | null;
        readonly sessionUrl: string | null;
      },
    ) =>
      Effect.gen(function* () {
        const author = yield* users.byId(input.authorUserId);
        if (author === null) {
          return yield* new LandingStepError({
            step: "commit",
            message: "the owner's account no longer exists",
          });
        }
        return yield* git.commit(scope, {
          checkpoint: input.checkpoint,
          agentHead: input.agentHead,
          lastLanded: input.lastLanded,
          keep: input.keep,
          author: { name: author.name, email: author.email },
          message: landingCommitMessage({
            tourSummary: input.tourSummary,
            label: scope.session.label,
            sessionId: scope.session.id,
            sessionUrl: input.sessionUrl,
          }),
        });
      });

    const land = Effect.fn("Landing.land")(function* (input: LandInput) {
      const scope = yield* scopeOf(input.sessionId);
      const { session, project, worktree } = scope;
      // The change's owner, not the calling session's: a teammate who started a session in
      // this worktree, or steers one under shared control, never lands it.
      const owner = changeOwnerOf(yield* sessions.listForWorktree(worktree.id));
      if (owner === null) {
        return yield* notStarted("no-owner", "landing not started · the change has no owner");
      }
      if (owner !== input.actorUserId) {
        return yield* notStarted(
          "not-owner",
          "landing not started · only the change's owner lands it",
        );
      }
      const change = yield* changes.byWorktree(worktree.id);
      if (change === null) {
        return yield* notStarted("no-change", "landing not started · the session has no change");
      }
      const history = yield* landings.listForChange(change.id);
      // L: what the change's last landing pushed. A landing that pushed nothing leaves neither
      // a commit to build on nor a branch name to reuse.
      const lastPush = history.find((landing) => landing.pushedSha !== null);
      const remoteBranch = input.remoteBranch ?? lastPush?.remoteBranch ?? worktree.branch;
      const base = pullRequestBase(worktree.baseRef, project.defaultBranch);
      if (remoteBranch === project.defaultBranch || remoteBranch === base) {
        const which =
          remoteBranch === project.defaultBranch
            ? "the project's default branch"
            : "the pull request's base";
        return yield* notStarted(
          "branch",
          `landing not started · ${remoteBranch} is ${which} · name another branch`,
        );
      }

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
      const { checkpoint, agentHead } = taken.success;

      // 2. Commit what the agent left uncommitted, as the owner.
      const tour = yield* tours.byChange(change.id);
      const links = linksOf(input.webOrigin, session.id, change.id, checkpoint.ordinal);
      const committed = yield* commitWork(scope, {
        checkpoint,
        agentHead,
        lastLanded: lastPush?.pushedSha ?? null,
        keep: true,
        authorUserId: owner,
        tourSummary: tour?.summary ?? null,
        sessionUrl: links.session,
      }).pipe(Effect.result);
      if (Result.isFailure(committed)) {
        return yield* failed(checkpoint, null, committed.failure.message);
      }
      const { head, commitSha, nothingNew } = committed.success;
      const titleGiven = input.title !== null && input.title.trim() !== "";
      // Nothing new since a landing that finished what is asked now: no push, no row. A landing
      // whose pull request step failed, or one asked to open a pull request or retitle it, goes on.
      const latest = history[0];
      const wantsPullRequest =
        input.pullRequest && pullRequestAvailability(project.originUrl).available;
      if (
        nothingNew &&
        !titleGiven &&
        input.body === null &&
        latest !== undefined &&
        latest.pushedSha === head &&
        (latest.outcome === "pull-request" || (latest.outcome === "pushed" && !wantsPullRequest))
      ) {
        return yield* notStarted(
          "nothing-new",
          "landing not started · nothing new since the last landing",
        );
      }

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
          target: workspaceTarget(session, owner),
          repository: availability.repository,
          head: remoteBranch,
          base,
          title: pullRequestTitle({
            explicit: input.title,
            label: session.label,
            sessionId: session.id,
          }),
          titleGiven,
          body: input.body,
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
      // `gh` speaks as the landing's owner, in the landing session's workspace only when that
      // session is theirs.
      const session =
        landing.sessionId === null
          ? null
          : yield* sessions
              .byId(landing.sessionId)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      const observed = yield* pullRequests.observe({
        target:
          session === null
            ? { ownerUserId: landing.userId, sessionId: null }
            : workspaceTarget(session, landing.userId),
        repository: availability.repository,
        number: landing.pullRequest.number,
      });
      const updated = yield* landings.observePullRequest(landing.id, observed);
      return updated ?? landing;
    });

    const bundle = Effect.fn("Landing.bundle")(function* (input: BundleChangeInput) {
      const scope = yield* scopeOf(input.sessionId);
      const { session, worktree } = scope;
      const change = yield* changes.byWorktree(worktree.id);
      if (change === null) {
        return yield* notStarted("no-change", "bundle not made · the session has no change");
      }
      const owner = changeOwnerOf(yield* sessions.listForWorktree(worktree.id));
      // Pulling someone's change never adds to their record: only the change's owner gets a
      // checkpoint taken, anyone else the latest one there is.
      const recorded =
        owner !== null && owner === input.actorUserId
          ? yield* git.checkpoint(scope, "user-mark")
          : yield* git.latest(scope);
      const { checkpoint, agentHead } = recorded;
      if (checkpoint === null) {
        return yield* notStarted(
          "no-change",
          "bundle not made · the worktree has no checkpoint yet",
        );
      }
      const lastPush = (yield* landings.listForChange(change.id)).find(
        (landing) => landing.pushedSha !== null,
      );
      const tour = yield* tours.byChange(change.id);
      const { head } = yield* commitWork(scope, {
        checkpoint,
        agentHead,
        lastLanded: lastPush?.pushedSha ?? null,
        keep: false,
        authorUserId: owner ?? input.actorUserId,
        tourSummary: tour?.summary ?? null,
        sessionUrl: linksOf(input.webOrigin, session.id, change.id, checkpoint.ordinal).session,
      });
      return yield* git.bundle(scope, {
        base: worktree.baseSha,
        tip: head,
        branch: worktree.branch,
        limitBytes: input.limitBytes,
      });
    });

    return { land, bundle, refreshPullRequest };
  }),
);
