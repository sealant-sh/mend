import {
  ChangeLandingsRepo,
  ChangeToursRepo,
  CheckpointsRepo,
  ProjectsRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ChangeId } from "@mend/domain";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { describedFileOf, describePullRequest, pullRequestTitle } from "./description.ts";
import { pullRequestAvailability, pullRequestBase } from "./github.ts";
import { LandingGit, linksOf } from "./landing.ts";
import { PullRequests, PullRequestStepError } from "./pull-requests.ts";

/**
 * The pull request gains the tour when the tour completes (docs/adr/0007-landing.md, "What the
 * thread sees"). A landing that found no tour opened its pull request with the file list and asked
 * for one; when a tour for the change completes, the worker writes it into Mend's section of the
 * pull request Mend opened, through the same pull request step, as the change's owner.
 *
 * Once per tour: the landing is claimed for the tour in Postgres before anything is sent, so a
 * second worker, or the same tour finishing twice, updates nothing. A pull request that was
 * described after the tour existed already has it, and one GitHub last reported closed or merged
 * is left alone. Nothing retries: a failure is logged, and the next landing writes the tour.
 */

/** What the worker did with a completed tour. */
export type TourDescription =
  | { readonly _tag: "updated"; readonly number: number }
  /** No open pull request from Mend lacks this tour, or another worker claimed it. */
  | { readonly _tag: "unchanged" };

export class LandingDescriptions extends Context.Service<
  LandingDescriptions,
  {
    readonly afterTour: (input: {
      readonly changeId: ChangeId;
      /** The web origin the description's links are built from; null writes none. */
      readonly webOrigin: string | null;
    }) => Effect.Effect<TourDescription, PullRequestStepError>;
  }
>()("@mend/landing/LandingDescriptions") {}

const UNCHANGED: TourDescription = { _tag: "unchanged" };

export const LandingDescriptionsLive: Layer.Layer<
  LandingDescriptions,
  never,
  | ChangeLandingsRepo
  | ChangeToursRepo
  | CheckpointsRepo
  | ProjectsRepo
  | SessionsRepo
  | WorktreeChangesRepo
  | WorktreesRepo
  | LandingGit
  | PullRequests
> = Layer.effect(
  LandingDescriptions,
  Effect.gen(function* () {
    const landings = yield* ChangeLandingsRepo;
    const tours = yield* ChangeToursRepo;
    const checkpoints = yield* CheckpointsRepo;
    const projects = yield* ProjectsRepo;
    const sessions = yield* SessionsRepo;
    const changes = yield* WorktreeChangesRepo;
    const worktrees = yield* WorktreesRepo;
    const git = yield* LandingGit;
    const pullRequests = yield* PullRequests;

    const afterTour = Effect.fn("LandingDescriptions.afterTour")(function* (input: {
      readonly changeId: ChangeId;
      readonly webOrigin: string | null;
    }) {
      const tour = yield* tours.byChange(input.changeId);
      if (tour === null) return UNCHANGED;
      const history = yield* landings.listForChange(input.changeId);
      const landing = history.find((candidate) => candidate.pullRequest !== null);
      if (landing === undefined || landing.pullRequest === null || landing.pushedSha === null) {
        return UNCHANGED;
      }
      // Described with this tour already (it existed when the landing ran), or GitHub last said
      // the pull request is no longer open.
      if (landing.createdAt.getTime() >= tour.createdAt.getTime()) return UNCHANGED;
      if (landing.pullRequest.state !== "open") return UNCHANGED;
      if (!(yield* landings.claimTourDescription(landing.id, tour.id))) return UNCHANGED;

      const pushedSha = landing.pushedSha;
      const { number } = landing.pullRequest;
      const unavailable = (message: string) => new PullRequestStepError({ message });
      const project = yield* projects
        .byId(landing.projectId)
        .pipe(Effect.mapError(() => unavailable(`no project ${landing.projectId}`)));
      const availability = pullRequestAvailability(project.originUrl);
      if (!availability.available) return yield* unavailable(availability.reason);
      const session =
        landing.sessionId === null
          ? null
          : yield* sessions
              .byId(landing.sessionId)
              .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      const worktree = yield* changes.byId(input.changeId).pipe(
        Effect.flatMap((change) => worktrees.byId(change.worktreeId)),
        Effect.mapError(() => unavailable(`no worktree for change ${input.changeId}`)),
      );
      const checkpoint =
        landing.checkpointId === null ? null : yield* checkpoints.byId(landing.checkpointId);
      const files = yield* git
        .changedFiles({ project, worktree }, { base: worktree.baseSha, head: pushedSha })
        .pipe(
          Effect.map((facts) => facts.map(describedFileOf)),
          Effect.catch((error) =>
            Effect.logWarning("landing: the landed files could not be listed").pipe(
              Effect.annotateLogs({ landingId: landing.id, error: error.message }),
              Effect.as(null),
            ),
          ),
        );
      const sessionId = landing.sessionId ?? input.changeId;
      const ordinal = checkpoint?.ordinal ?? 0;
      const published = yield* pullRequests.publish({
        // `gh` speaks as the change's owner, in the landing session's workspace only when it is
        // theirs.
        target: {
          ownerUserId: landing.userId,
          sessionId: session !== null && session.ownerUserId === landing.userId ? session.id : null,
        },
        repository: availability.repository,
        head: landing.remoteBranch,
        base: pullRequestBase(worktree.baseRef, project.defaultBranch),
        title: pullRequestTitle({ explicit: null, label: session?.label ?? null, sessionId }),
        // A title the owner gave, or edited on GitHub, is kept.
        titleGiven: false,
        body: null,
        section: describePullRequest({
          tour: { summary: tour.summary, approach: tour.approach },
          files,
          checks: [],
          checkpoint: { ordinal, sha: landing.checkpointSha ?? pushedSha },
          links:
            landing.sessionId === null
              ? { session: null, review: null, checkpoint: null }
              : linksOf(input.webOrigin, landing.sessionId, input.changeId, ordinal),
        }),
        previous: number,
      });
      yield* landings.observePullRequest(landing.id, published.pullRequest);
      return { _tag: "updated", number: published.pullRequest.number } satisfies TourDescription;
    });

    return { afterTour };
  }),
);
