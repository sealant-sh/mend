import {
  BUNDLE_HEADERS,
  BundleTooLarge,
  ChangeLandingsView,
  CurrentUser,
  LandingNotAllowed,
  LandingNotStarted,
  LandingReportView,
  MendApi,
  NotFound,
  PullRequestAvailabilityView,
  PullRequestStepFailed,
  RemoteBranchObservation,
  SessionGitOpView,
  StoreFailure,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
  ChangeLandingsRepo,
  ProjectsRepo,
  SessionGitOpsRepo,
  SessionsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import type { Change, ChangeLanding, Session } from "@mend/domain/workbench";
import { Landing, type LandingNotStartedError, pullRequestAvailability } from "@mend/landing";
import { NetworkConfig } from "@mend/network";
import { Clock, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";
import { budgetMessage, Budgets } from "../budgets.ts";
import { changeOwnerOfWorktree, observeLandings, remoteEnvFor } from "../landing-state.ts";
import { configuredOriginForRequest } from "./devices.ts";
import { withSignerContext } from "./workbench.ts";

/**
 * Landing over HTTP (docs/adr/0007-landing.md): land a session's change, read its record with
 * the facts observed about it, refresh a pull request's state, pull the change as a bundle, and
 * read the pushes the agent made itself.
 *
 * Landing pushes with the owner's key and speaks as the owner on GitHub, so only the change's
 * owner (the owner of its worktree's first session) lands or refreshes: not a teammate under
 * shared control, not a teammate who started a session in the owner's worktree, not an
 * organization owner. Anyone who can see the project reads the record, and pulls the bundle as
 * they would read the review diff; every download is audited.
 */

const ONLY_THE_OWNER = "only the change's owner lands it";

const notAllowed = (message: string) => new LandingNotAllowed({ message });

/** A landing that did not start, as the contract states it. */
const notStartedAs =
  (id: string) =>
  (error: LandingNotStartedError): NotFound | LandingNotAllowed | LandingNotStarted => {
    switch (error.reason) {
      case "not-found":
        return new NotFound({ id });
      case "no-owner":
      case "not-owner":
        return notAllowed(error.message);
      case "no-change":
      case "branch":
      case "nothing-new":
        return new LandingNotStarted({ message: error.message });
    }
  };

/** The origin every link in a commit message or a description starts with. */
const webOriginOfRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return configuredOriginForRequest(yield* NetworkConfig, request.headers);
});

const projectOf = (change: { readonly projectId: Change["projectId"] }) =>
  Effect.gen(function* () {
    return yield* (yield* ProjectsRepo)
      .byId(change.projectId)
      .pipe(Effect.mapError(() => new NotFound({ id: change.projectId })));
  });

/**
 * Whether this account may fetch origin now: "Check origin" is a call to a remote any viewer can
 * ask for, so each account's are bounded (`MEND_BUDGET_ACCOUNT_ORIGIN_CHECKS_PER_MINUTE`). Null
 * when it may; otherwise what the record says instead of the fetch.
 */
const originCheckRefusal = (userId: string) =>
  Effect.gen(function* () {
    const { limits, originChecks } = yield* Budgets;
    const wait = originChecks.take(
      userId,
      limits.accountOriginChecksPerMinute,
      yield* Clock.currentTimeMillis,
    );
    return wait === null
      ? null
      : `origin not checked · ${budgetMessage("accountOriginChecksPerMinute", limits.accountOriginChecksPerMinute)} · try again in ${wait} s`;
  });

/** The record and the observed facts for a change, as the Land panel reads them. */
const landingsView = (change: Change | null, session: Session | null, probe: boolean) =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    const worktreeId = change?.worktreeId ?? session?.worktreeId ?? null;
    const owner = worktreeId === null ? null : yield* changeOwnerOfWorktree(worktreeId);
    const land = owner !== null && owner === caller.user.id;
    if (change === null) {
      return new ChangeLandingsView({
        changeId: null,
        sessionId: session?.id ?? null,
        land,
        landings: [],
        facts: [],
        remote: null,
        remoteFailure: null,
        pullRequest: new PullRequestAvailabilityView({ available: false, reason: null }),
      });
    }
    const project = yield* projectOf(change);
    const worktree = yield* (yield* WorktreesRepo)
      .byId(change.worktreeId)
      .pipe(Effect.mapError(() => new NotFound({ id: change.id })));
    const refused = probe ? yield* originCheckRefusal(caller.user.id) : null;
    const observed = yield* observeLandings({
      change,
      project,
      worktree,
      probeAs: probe && refused === null ? caller.user.id : null,
    });
    const availability = pullRequestAvailability(project.originUrl);
    return new ChangeLandingsView({
      changeId: change.id,
      sessionId: session?.id ?? change.sessionId,
      land,
      landings: observed.landings,
      facts: observed.facts,
      remote:
        observed.remote === null
          ? null
          : new RemoteBranchObservation({
              remoteBranch: observed.remote.remoteBranch,
              remoteSha: observed.remote.remoteSha,
              unseen: observed.remote.unseen,
              ahead: observed.remote.ahead,
              holds: observed.remote.holds,
              observedAt: observed.remote.observedAt,
            }),
      remoteFailure: refused ?? observed.remoteFailure,
      pullRequest: new PullRequestAvailabilityView(
        availability.available
          ? { available: true, reason: null }
          : { available: false, reason: availability.reason },
      ),
    });
  });

/** The session a change lands as: its own, else the newest one in its worktree. */
const sessionOfChange = (change: Change) =>
  Effect.gen(function* () {
    const sessions = yield* SessionsRepo;
    if (change.sessionId !== null) {
      const own = yield* sessions
        .byId(change.sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (own !== null) return own;
    }
    const live = yield* (yield* WorktreesRepo).newestLiveSessionId(change.worktreeId);
    const members = yield* sessions.listForWorktree(change.worktreeId);
    return members.find((member) => member.id === live) ?? members[0] ?? null;
  });

/** Audit a landing, whatever its outcome: it acted with the owner's credentials. */
const auditLanding = (
  landing: ChangeLanding,
  organizationId: OrganizationId,
  actorUserId: string,
) =>
  Effect.gen(function* () {
    yield* (yield* AuditEventsRepo).record({
      organizationId,
      actorUserId,
      action: "change.landed",
      subjectType: "change",
      subjectId: landing.changeId,
      data: {
        sessionId: landing.sessionId,
        landingId: landing.id,
        outcome: landing.outcome,
        trigger: landing.trigger,
        remoteBranch: landing.remoteBranch,
        pushedSha: landing.pushedSha,
        pullRequest: landing.pullRequest?.number ?? null,
      },
    });
  });

export const LandingsGroupLive = HttpApiBuilder.group(MendApi, "landings", (handlers) =>
  handlers
    .handle("land", ({ params, payload }) =>
      Effect.gen(function* () {
        const session = yield* (yield* ProjectAccess).session(params.id);
        const caller = yield* CurrentUser;
        // Refused before anything moves: shared control lends steering, and a session in the
        // owner's worktree lends a place to work, never the change owner's key.
        const owner = yield* changeOwnerOfWorktree(session.worktreeId);
        if (owner === null || owner !== caller.user.id) {
          return yield* notAllowed(ONLY_THE_OWNER);
        }
        const project = yield* projectOf(session);
        const remoteEnv = yield* remoteEnvFor(project, caller.user.id, "push");
        const branch = payload.branch?.trim() ?? "";
        const report = yield* withSignerContext(
          project.gitAuthMode,
          caller.user.id,
          `land ${session.label ?? session.id} → origin`,
          (yield* Landing).land({
            sessionId: session.id,
            actorUserId: caller.user.id,
            trigger: "manual",
            remoteBranch: branch === "" ? null : branch,
            pullRequest: payload.pullRequest,
            title: payload.title,
            body: payload.body,
            webOrigin: yield* webOriginOfRequest,
            remoteEnv,
          }),
        ).pipe(Effect.mapError(notStartedAs(params.id)));
        yield* auditLanding(report.landing, project.organizationId, caller.user.id);
        return new LandingReportView({
          landing: report.landing,
          pullRequest: report.pullRequest,
        });
      }),
    )
    .handle("forSession", ({ params, query }) =>
      Effect.gen(function* () {
        const session = yield* (yield* ProjectAccess).session(params.id);
        const change = yield* (yield* WorktreeChangesRepo).byWorktree(session.worktreeId);
        return yield* landingsView(change, session, query.probe === "true");
      }),
    )
    .handle("forChange", ({ params, query }) =>
      Effect.gen(function* () {
        const change = yield* (yield* ProjectAccess).change(params.id);
        const session = yield* sessionOfChange(change);
        return yield* landingsView(change, session, query.probe === "true");
      }),
    )
    .handle("refresh", ({ params }) =>
      Effect.gen(function* () {
        const landing = yield* (yield* ChangeLandingsRepo).byId(params.id);
        if (landing === null) return yield* new NotFound({ id: params.id });
        // Visible exactly when its change is; the id in a refusal is the one asked for.
        const change = yield* (yield* ProjectAccess)
          .change(landing.changeId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        const caller = yield* CurrentUser;
        // `gh` speaks as the change's owner, so only they ask it.
        const owner = yield* changeOwnerOfWorktree(change.worktreeId);
        if (owner === null || owner !== caller.user.id || landing.userId !== caller.user.id) {
          return yield* notAllowed(ONLY_THE_OWNER);
        }
        const refreshed = yield* (yield* Landing).refreshPullRequest(params.id).pipe(
          Effect.catchTags({
            LandingNotStartedError: () => Effect.fail(new NotFound({ id: params.id })),
            PullRequestStepError: (error) =>
              Effect.fail(new PullRequestStepFailed({ message: error.message })),
          }),
        );
        if (refreshed.pullRequest !== null) {
          const project = yield* projectOf(refreshed);
          yield* (yield* AuditEventsRepo).record({
            organizationId: project.organizationId,
            actorUserId: caller.user.id,
            action: "change.pull_request_refreshed",
            subjectType: "change",
            subjectId: refreshed.changeId,
            data: {
              landingId: refreshed.id,
              pullRequest: refreshed.pullRequest.number,
              state: refreshed.pullRequest.state,
            },
          });
        }
        return refreshed;
      }),
    )
    .handle("bundle", ({ params }) =>
      Effect.gen(function* () {
        const change = yield* (yield* ProjectAccess).change(params.id);
        const session = yield* sessionOfChange(change);
        if (session === null) {
          return yield* new StoreFailure({
            message: "No conversation has inhabited this worktree yet — nothing to bundle.",
          });
        }
        const caller = yield* CurrentUser;
        const { limits } = yield* Budgets;
        const bundle = yield* (yield* Landing)
          .bundle({
            sessionId: session.id,
            actorUserId: caller.user.id,
            webOrigin: yield* webOriginOfRequest,
            // `0` turns the budget off.
            limitBytes: limits.bundleBytes > 0 ? limits.bundleBytes : Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.catchTags({
              LandingNotStartedError: (error) =>
                Effect.fail(
                  error.reason === "not-found"
                    ? new NotFound({ id: params.id })
                    : new StoreFailure({ message: error.message }),
                ),
              LandingStepError: (error) =>
                Effect.fail(new StoreFailure({ message: `${error.step} · ${error.message}` })),
              BundleTooLargeError: (error) =>
                Effect.fail(
                  new BundleTooLarge({
                    size: error.size,
                    limit: error.limit,
                    message: `bundle not sent · ${error.size} bytes · the limit is ${error.limit} bytes (MEND_BUDGET_BUNDLE_BYTES)`,
                  }),
                ),
              BundleEmptyError: () =>
                Effect.fail(
                  new StoreFailure({
                    message: "nothing to bundle · the change has no commits past its base",
                  }),
                ),
            }),
          );
        const project = yield* projectOf(change);
        yield* (yield* AuditEventsRepo).record({
          organizationId: project.organizationId,
          actorUserId: caller.user.id,
          action: "change.bundle_downloaded",
          subjectType: "change",
          subjectId: change.id,
          data: {
            sessionId: session.id,
            branch: bundle.branch,
            base: bundle.base,
            tip: bundle.tip,
            commits: bundle.commits,
            bytes: bundle.bytes.byteLength,
          },
        });
        return HttpServerResponse.uint8Array(bundle.bytes, {
          contentType: "application/x-git-bundle",
          headers: {
            "content-disposition": `attachment; filename="${bundle.branch.replaceAll("/", "-")}.bundle"`,
            [BUNDLE_HEADERS.branch]: bundle.branch,
            [BUNDLE_HEADERS.base]: bundle.base,
            [BUNDLE_HEADERS.tip]: bundle.tip,
            [BUNDLE_HEADERS.commits]: String(bundle.commits),
          },
        });
      }),
    )
    .handle("gitOps", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.id);
        const ops = yield* (yield* SessionGitOpsRepo).listForSession(params.id);
        return ops.map(
          (op) =>
            new SessionGitOpView({
              id: op.id,
              sessionId: op.sessionId,
              host: op.host,
              port: op.port,
              kind: op.kind,
              command: op.command,
              authMode: op.authMode,
              refUpdates: op.refUpdates,
              exitCode: op.exitCode,
              startedAt: op.startedAt,
              finishedAt: op.finishedAt,
            }),
        );
      }),
    ),
);
