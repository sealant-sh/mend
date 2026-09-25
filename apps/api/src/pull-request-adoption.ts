import { AuditEventsRepo, ProjectsRepo, WorktreeChangesRepo } from "@mend/db";
import { ChangeId, type WorktreeId } from "@mend/domain";
import { JobRunner } from "@mend/jobs";
import { Landing } from "@mend/landing";
import { WorkspaceGitHooks } from "@mend/sessions";
import { Cause, Effect, Layer, Schema } from "effect";

import { auditAdoption } from "./landing-state.ts";

/**
 * Pull requests opened outside Mend (docs/adr/0007-landing.md): the agent may push its branch and
 * open a pull request itself, with `gh` in its workspace, and Mend's next landing must update that
 * one instead of opening a second. Two moments look for it, both with the owner's `gh` in a live
 * workspace of theirs, never a new one:
 *
 * - a push through the transport that moved a branch queues a look 45 s later, when a pull
 *   request from that branch has had time to be opened (`adopt-pull-request`, one per change
 *   while queued);
 * - an agent that ended while its workspace is still up is looked after at once, before the
 *   workspace may stop.
 *
 * The owner's "Check GitHub" in the Land panel is the third, on demand.
 */

export const ADOPT_PULL_REQUEST_JOB = "adopt-pull-request";

/** How long after a push the look runs: `gh pr create` follows the push. */
const AFTER_PUSH_SECONDS = 45;

const AdoptPullRequestJob = Schema.Struct({ changeId: ChangeId });
const decodeJob = Schema.decodeUnknownEffect(AdoptPullRequestJob);

export const PullRequestAdoptionLive: Layer.Layer<
  never,
  never,
  WorkspaceGitHooks | JobRunner | Landing | WorktreeChangesRepo | ProjectsRepo | AuditEventsRepo
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* WorkspaceGitHooks;
    const jobs = yield* JobRunner;
    const landing = yield* Landing;
    const changes = yield* WorktreeChangesRepo;
    const projects = yield* ProjectsRepo;
    // The handlers run outside any request: they carry the audit log with them.
    const audit = yield* Effect.context<AuditEventsRepo>();

    /** Look once, in the background; what came of it is logged, and an adoption audited. */
    const adopt = (changeId: ChangeId) =>
      landing.adoptPullRequest({ changeId, background: true }).pipe(
        Effect.tap((adoption) =>
          Effect.gen(function* () {
            if (adoption._tag !== "adopted") return;
            const project = yield* projects.byId(adoption.landing.projectId);
            yield* auditAdoption(adoption.landing, project.organizationId).pipe(
              Effect.provide(audit),
            );
            yield* Effect.logInfo("landing: a pull request opened outside Mend was adopted").pipe(
              Effect.annotateLogs({
                changeId,
                pullRequest: adoption.landing.pullRequest?.number,
                branch: adoption.landing.remoteBranch,
                fork: adoption.landing.pullRequestCrossRepository,
              }),
            );
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("landing: the look for a pull request opened outside Mend failed").pipe(
            Effect.annotateLogs({ changeId, cause: Cause.pretty(cause) }),
          ),
        ),
        Effect.asVoid,
      );

    const changeOf = (worktreeId: WorktreeId) =>
      changes.byWorktree(worktreeId).pipe(Effect.map((change) => change?.id ?? null));

    yield* jobs.work(ADOPT_PULL_REQUEST_JOB, (payload) =>
      decodeJob(payload).pipe(
        Effect.flatMap((job) => adopt(job.changeId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("landing: an adopt-pull-request job could not be read").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    );

    yield* hooks.register({
      branchesPushed: (event) =>
        changeOf(event.worktreeId).pipe(
          Effect.flatMap((changeId) =>
            changeId === null
              ? Effect.void
              : jobs
                  .enqueue({
                    name: ADOPT_PULL_REQUEST_JOB,
                    payload: { changeId },
                    idempotencyKey: `${ADOPT_PULL_REQUEST_JOB}:${changeId}`,
                    startAfterSeconds: AFTER_PUSH_SECONDS,
                    // A look that found nothing is not a failure; a gh that failed is logged.
                    retryLimit: 0,
                  })
                  .pipe(Effect.asVoid),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("landing: the look after a push could not be queued").pipe(
              Effect.annotateLogs({ sessionId: event.sessionId, cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      agentEnded: (event) =>
        changeOf(event.worktreeId).pipe(
          Effect.flatMap((changeId) => (changeId === null ? Effect.void : adopt(changeId))),
        ),
    });
  }),
);
