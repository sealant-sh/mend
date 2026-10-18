import {
  BudgetExceeded,
  HandoffReceived,
  HandoffRefused,
  HandoffTerms,
  NotFound,
  StoreFailure,
} from "@mend/api-contracts";
import { AuditEventsRepo, isUniqueViolation, SessionsRepo, WorktreesRepo } from "@mend/db";
import { Sha, type ProjectId } from "@mend/domain";
import { handoffWorktreeName, type Project, type Session } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import {
  AgentBridge,
  DeploymentConfig,
  MendKeys,
  parseBundleHeader,
  preparedRemoteEnvironment,
  SourcePolicy,
  Store,
  unsupportedRepositoryReason,
  type AdmittedHandoff,
} from "@mend/store";
import { Deferred, Effect, Fiber, Option } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { Budgets } from "./budgets.ts";
import { requireSessionRoom } from "./session-budgets.ts";
import { LAUNCH_ANSWER_WINDOW, settleIfUnlaunched } from "./session-start.ts";

export interface HandoffQueryInput {
  readonly harness: string;
  readonly hold: "true" | "false";
}

type HandoffError = NotFound | HandoffRefused | BudgetExceeded | StoreFailure;

/**
 * Receiving a `mend handoff` (docs/specs/mend-handoff.md, "Engine verb"), as a given account:
 * the project's terms before any bytes are sent, and the bundle itself. One implementation for
 * the route, with the same checks in the same order each time: access, the store kind and the
 * repository's format, the replay lookup by the snapshot's sha (before the session budget, so a
 * retry of the same bytes is never refused for room), the session budget, admission, provision,
 * the audit event, and the hold.
 */
export class HandoffStart extends Context.Service<
  HandoffStart,
  {
    readonly termsAs: (
      userId: string,
      projectId: ProjectId,
    ) => Effect.Effect<HandoffTerms, NotFound | HandoffRefused>;
    readonly receiveAs: (
      userId: string,
      projectId: ProjectId,
      query: HandoffQueryInput,
      bytes: Uint8Array,
    ) => Effect.Effect<HandoffReceived, HandoffError>;
  }
>()("@mend/api/HandoffStart") {}

const termOf = (limit: number): number => (limit > 0 ? limit : Number.MAX_SAFE_INTEGER);

const refused = (reason: HandoffRefused["reason"], message: string) =>
  new HandoffRefused({ reason, message: `${message} · nothing was created` });

const unheld = (session: Session) =>
  session.status === "starting" &&
  session.settledAt === null &&
  session.sealantWorkspaceId === null &&
  session.sealantRunId === null;

const inFlight = new Map<string, Deferred.Deferred<HandoffReceived, HandoffError>>();

export const makeHandoffStart = Effect.gen(function* () {
  const access = yield* ProjectAccess;
  const engine = yield* SessionEngine;
  const budgets = yield* Budgets;
  const sessions = yield* SessionsRepo;
  const worktrees = yield* WorktreesRepo;
  const store = yield* Store;
  const deployment = yield* DeploymentConfig;
  const audit = yield* AuditEventsRepo;
  const policy = yield* SourcePolicy;
  const mendKeys = yield* MendKeys;
  const agentBridge = yield* AgentBridge;

  const admissible = Effect.fn("HandoffStart.admissible")(function* (project: Project) {
    if (deployment.sessionStore !== "captured") {
      return yield* refused(
        "store-co-located",
        "this server keeps worktrees in the co-located store, which takes no handoffs · the operator can unset MEND_SESSION_STORE to run the capture store",
      );
    }
    const reason = yield* unsupportedRepositoryReason(project.storePath).pipe(
      Effect.catchTag("GitError", () => Effect.succeed(null)),
    );
    if (reason !== null) return yield* refused("unsupported-repository", reason);
  });

  const termsAs = Effect.fn("HandoffStart.termsAs")(function* (
    userId: string,
    projectId: ProjectId,
  ) {
    const project = yield* access.projectAs(userId, projectId);
    yield* admissible(project);
    return new HandoffTerms({
      bundleBytes: termOf(budgets.limits.bundleBytes),
      fileBytes: termOf(budgets.limits.handoffFileBytes),
    });
  });

  const remoteEnvFor = (project: Project, userId: string) =>
    Effect.gen(function* () {
      const isOperator = yield* access.isOperator(userId);
      return yield* preparedRemoteEnvironment({
        policy,
        source: project.originUrl,
        actor: { isOperator },
        mode: project.gitAuthMode,
        userId,
      }).pipe(
        Effect.provideService(MendKeys, mendKeys),
        Effect.provideService(AgentBridge, agentBridge),
      );
    });

  const admit = Effect.fn("HandoffStart.admit")(function* (
    project: Project,
    userId: string,
    bytes: Uint8Array,
  ) {
    const remoteEnv = yield* remoteEnvFor(project, userId);
    return yield* store
      .admitHandoff(project.storePath, project.defaultBranch, bytes, remoteEnv)
      .pipe(
        Effect.catchTags({
          HandoffRefusedError: (error) =>
            Effect.fail(new HandoffRefused({ reason: error.reason, message: error.message })),
          GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
        }),
      );
  });

  const hold = Effect.fn("HandoffStart.hold")(function* (session: Session) {
    const resume = engine.resumeSession(session.id, "shell", false).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error.message;
          yield* settleIfUnlaunched(sessions, session, `hold failed: ${message}`).pipe(
            Effect.ignore,
          );
          yield* Effect.logWarning("handoff: the hold failed").pipe(
            Effect.annotateLogs({ sessionId: session.id, error: message }),
          );
          return session;
        }),
      ),
    );
    const fiber = yield* engine.detach(resume);
    const answered = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(LAUNCH_ANSWER_WINDOW));
    return Option.isSome(answered)
      ? answered.value
      : yield* sessions
          .byId(session.id)
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(session)));
  });

  const replay = Effect.fn("HandoffStart.replay")(function* (
    project: Project,
    userId: string,
    query: HandoffQueryInput,
    admitted: AdmittedHandoff,
  ) {
    const worktree = yield* worktrees.byHandoffCheckpoint(project.id, admitted.checkpoint);
    if (worktree === null) return null;
    const first = (yield* sessions.listForWorktree(worktree.id)).at(-1) ?? null;
    if (first !== null && first.ownerUserId !== userId) {
      return yield* new StoreFailure({
        message: "this handoff was received before, for another account · nothing was created",
      });
    }
    const session =
      first ??
      (yield* engine
        .provisionSessionIn(worktree.id, {
          harness: query.harness,
          label: null,
          ownerUserId: userId,
          origin: "mend",
        })
        .pipe(
          Effect.catchTags({
            WorktreeNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
            ProjectNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
            GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
          }),
        ));
    const held = query.hold === "true" && unheld(session) ? yield* hold(session) : session;
    return new HandoffReceived({
      session: held,
      worktree,
      commitsAhead: admitted.commitsAhead,
      replayed: true,
    });
  });

  const receive = Effect.fn("HandoffStart.receive")(function* (
    project: Project,
    userId: string,
    query: HandoffQueryInput,
    bytes: Uint8Array,
  ) {
    const snapshot = parseBundleHeader(bytes)?.refs[0]?.sha;
    const earlier =
      snapshot === undefined
        ? null
        : yield* worktrees.byHandoffCheckpoint(project.id, Sha.make(snapshot));
    if (earlier !== null) {
      const admitted = yield* admit(project, userId, bytes);
      const replayed = yield* replay(project, userId, query, admitted);
      if (replayed !== null) return replayed;
    }
    yield* requireSessionRoom(userId, project.organizationId).pipe(
      Effect.provideService(Budgets, budgets),
      Effect.provideService(SessionsRepo, sessions),
    );
    const admitted = yield* admit(project, userId, bytes);
    const taken = new Set((yield* worktrees.listForProject(project.id)).map((row) => row.name));
    const name = handoffWorktreeName(admitted.trailers.localBranch, admitted.head, (candidate) =>
      taken.has(candidate),
    );
    const provisioned = yield* engine
      .provision({
        projectId: project.id,
        harness: query.harness,
        label: null,
        name,
        start: { kind: "handoff", admitted },
        ownerUserId: userId,
        origin: "mend",
      })
      .pipe(
        Effect.map((session): Session | null => session),
        Effect.catchTags({
          ProjectNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
          GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
          WorktreeBaseConflictError: (error) =>
            Effect.fail(new StoreFailure({ message: `worktree "${error.name}" already exists` })),
          HarnessLayoutNotAppliedError: (error) =>
            Effect.fail(new StoreFailure({ message: error.message })),
        }),
        Effect.catchDefect((defect) =>
          isUniqueViolation(defect) ? Effect.succeed(null) : Effect.die(defect),
        ),
      );
    if (provisioned === null) {
      const replayed = yield* replay(project, userId, query, admitted);
      if (replayed === null) {
        return yield* new StoreFailure({
          message: "the handoff's worktree was made elsewhere and cannot be found · hand off again",
        });
      }
      return replayed;
    }
    const worktree = yield* worktrees
      .byId(provisioned.worktreeId)
      .pipe(
        Effect.catchTag("WorktreeNotFoundError", () =>
          Effect.fail(new NotFound({ id: project.id })),
        ),
      );
    yield* audit.record({
      organizationId: project.organizationId,
      actorUserId: userId,
      action: "worktree.handed_off",
      subjectType: "worktree",
      subjectId: worktree.id,
      data: { projectId: project.id, sessionId: provisioned.id },
    });
    const session = query.hold === "true" ? yield* hold(provisioned) : provisioned;
    return new HandoffReceived({
      session,
      worktree,
      commitsAhead: admitted.commitsAhead,
      replayed: false,
    });
  });

  const receiveAs = Effect.fn("HandoffStart.receiveAs")(function* (
    userId: string,
    projectId: ProjectId,
    query: HandoffQueryInput,
    bytes: Uint8Array,
  ) {
    const project = yield* access.projectAs(userId, projectId);
    yield* admissible(project);
    const snapshot = parseBundleHeader(bytes)?.refs[0]?.sha;
    const key = snapshot === undefined ? null : `${project.id}:${snapshot}`;
    const joined = key === null ? undefined : inFlight.get(key);
    if (joined !== undefined) return yield* Deferred.await(joined);
    const deferred = Deferred.makeUnsafe<HandoffReceived, HandoffError>();
    if (key !== null) inFlight.set(key, deferred);
    return yield* receive(project, userId, query, bytes).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (key !== null) inFlight.delete(key);
          Deferred.doneUnsafe(deferred, exit);
        }),
      ),
    );
  });

  return { termsAs, receiveAs };
});
