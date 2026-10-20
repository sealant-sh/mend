import {
  BudgetExceeded,
  HandoffReceived,
  HandoffRefused,
  HandoffTerms,
  NotFound,
  StoreFailure,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
  SessionsRepo,
  StoreRefsRepo,
  uniqueViolationConstraint,
  WorktreesRepo,
} from "@mend/db";
import { Sha, type ProjectId } from "@mend/domain";
import {
  handoffWorktreeName,
  type Project,
  type Session,
  type Worktree,
} from "@mend/domain/workbench";
import { isWorktreeNameTaken, SessionEngine } from "@mend/sessions";
import {
  AgentBridge,
  DeploymentConfig,
  MendKeys,
  parseBundleHeader,
  preparedRemoteEnvironment,
  sha256Hex,
  skippedFreshen,
  SourcePolicy,
  Store,
  unsupportedRepositoryReason,
  type AdmittedHandoff,
} from "@mend/store";
import { Clock, Deferred, Effect, Fiber, Layer, Option } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { budgetMessage, Budgets } from "./budgets.ts";
import { budgetExceeded, requireSessionRoom } from "./session-budgets.ts";
import { LAUNCH_ANSWER_WINDOW, settleIfUnlaunched } from "./session-start.ts";

export interface HandoffQueryInput {
  readonly harness: string;
  readonly hold: "true" | "false";
}

type HandoffError = NotFound | HandoffRefused | BudgetExceeded | StoreFailure;

/** How many names a handoff tries past the one it computed before it gives up on a race. */
const NAME_TRIES = 5;

/** One try at the worktree: made, its name taken meanwhile, or the snapshot's row raced in. */
type ProvisionOutcome =
  | { readonly kind: "made"; readonly session: Session; readonly name: string }
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "replayed" };

/**
 * Receiving a `mend handoff` (docs/specs/mend-handoff.md, "Engine verb"), as a given account:
 * the project's terms before any bytes are sent, and the bundle itself. One implementation for
 * the route, with the same checks in the same order each time: access, the store kind and the
 * repository's format, the replay lookup by the snapshot's sha (before the session budget, so a
 * retry of the same bytes is never refused for room), the session budget, admission, provision,
 * the audit event, and the hold. The work runs detached from the request: a connection that
 * drops mid-way never interrupts it, and a retry of the same bytes by the same account joins it.
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

/** A session the hold has not reached: nothing of it asked of the platform yet. */
const unheld = (session: Session) =>
  session.status === "starting" &&
  session.settledAt === null &&
  session.sealantWorkspaceId === null &&
  session.sealantRunId === null;

const BRANCH_PREFIX = "refs/heads/mend/";

/**
 * The caller's earlier handoff of the same local branch among the names this one passed over on
 * its way to `chosen` (`fix-login`, `fix-login-2`, … in that order), the newest when several: the
 * one the CLI names (`fix-login is your earlier handoff`).
 */
const previousOf = (
  rows: ReadonlyArray<Worktree>,
  chosen: string,
  userId: string,
  admitted: AdmittedHandoff,
): { readonly name: string } | null => {
  const passed = new Set<string>();
  for (;;) {
    const name = handoffWorktreeName(admitted.trailers.localBranch, admitted.head, (candidate) =>
      passed.has(candidate),
    );
    if (name === chosen) break;
    passed.add(name);
  }
  const earlier = rows
    .filter(
      (row) =>
        passed.has(row.name) &&
        row.handoff !== null &&
        row.handoff.ownerUserId === userId &&
        row.handoff.localBranch !== null &&
        row.handoff.localBranch === admitted.trailers.localBranch,
    )
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .at(0);
  return earlier === undefined ? null : { name: earlier.name };
};

export const makeHandoffStart = Effect.gen(function* () {
  const access = yield* ProjectAccess;
  const engine = yield* SessionEngine;
  const budgets = yield* Budgets;
  const sessions = yield* SessionsRepo;
  const worktrees = yield* WorktreesRepo;
  const storeRefs = yield* StoreRefsRepo;
  const store = yield* Store;
  const deployment = yield* DeploymentConfig;
  const audit = yield* AuditEventsRepo;
  const policy = yield* SourcePolicy;
  const mendKeys = yield* MendKeys;
  const agentBridge = yield* AgentBridge;
  /** The receives under way, by caller, project and the bytes themselves. */
  const inFlight = new Map<string, Deferred.Deferred<HandoffReceived, HandoffError>>();

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

  /**
   * One freshen of origin's default branch for the admission, spent only when the store lacks
   * the bundle's base or tip: counted under the account's origin-checks window, as "Check
   * origin" is, and skipped in words when that window is spent.
   */
  const freshenFor = (project: Project, userId: string) =>
    Effect.gen(function* () {
      const { limits, originChecks } = budgets;
      const wait = originChecks.take(
        userId,
        limits.accountOriginChecksPerMinute,
        yield* Clock.currentTimeMillis,
      );
      if (wait !== null) {
        return skippedFreshen(
          `${budgetMessage("accountOriginChecksPerMinute", limits.accountOriginChecksPerMinute)} · try again in ${wait} s`,
        );
      }
      const remoteEnv = yield* remoteEnvFor(project, userId);
      return yield* store.freshenBase(project.storePath, project.defaultBranch, remoteEnv);
    });

  const admit = Effect.fn("HandoffStart.admit")(function* (
    project: Project,
    userId: string,
    bytes: Uint8Array,
  ) {
    return yield* store
      .admitHandoff(project.storePath, project.defaultBranch, bytes, {
        freshen: freshenFor(project, userId),
        fileBytes: budgets.limits.handoffFileBytes,
      })
      .pipe(
        Effect.catchTags({
          HandoffRefusedError: (error) =>
            Effect.fail(new HandoffRefused({ reason: error.reason, message: error.message })),
          HandoffFileOverBudgetError: (error) =>
            Effect.fail(
              new BudgetExceeded({
                budget: "handoffFileBytes",
                limit: error.limit,
                retryAfterSeconds: null,
                message: `${error.path} is ${error.bytes} bytes, over the ${budgetMessage("handoffFileBytes", error.limit)} · leave it out and hand off again · nothing was created`,
              }),
            ),
          GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
        }),
      );
  });

  /**
   * Hold the session's workspace with no agent, forked past the answer window the way a launch
   * is, and answer the session as it then stands: held (`idle`), still `starting` when the hold
   * outlives the window, or `failed` with the hold's words when it could not be held.
   */
  const hold = Effect.fn("HandoffStart.hold")(function* (session: Session, userId: string) {
    const holding = engine.holdWorkspace(session.id, userId).pipe(
      Effect.map((held): Session | null => held),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error.message;
          yield* settleIfUnlaunched(sessions, session, `hold failed: ${message}`).pipe(
            Effect.ignore,
          );
          yield* Effect.logWarning("handoff: the hold failed").pipe(
            Effect.annotateLogs({ sessionId: session.id, error: message }),
          );
          return null;
        }),
      ),
    );
    const fiber = yield* engine.detach(holding);
    const answered = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(LAUNCH_ANSWER_WINDOW));
    if (Option.isSome(answered) && answered.value !== null) return answered.value;
    return yield* sessions
      .byId(session.id)
      .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(session)));
  });

  const sessionIn = Effect.fn("HandoffStart.sessionIn")(function* (
    project: Project,
    worktree: Worktree,
    userId: string,
    query: HandoffQueryInput,
  ) {
    const first = (yield* sessions.listForWorktree(worktree.id)).at(-1);
    return (
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
        ))
    );
  });

  /**
   * The same bytes arrived before: the worktree they made, finished when its creation died
   * early, its first session (provisioned when there is none), and the hold when the session
   * is still owed one. Only the account the handoff was received for may replay it.
   */
  const replay = Effect.fn("HandoffStart.replay")(function* (
    project: Project,
    earlier: Worktree,
    userId: string,
    query: HandoffQueryInput,
    admitted: AdmittedHandoff,
  ) {
    if (earlier.handoff?.ownerUserId !== userId) {
      return yield* new StoreFailure({
        message: "this handoff was received before, for another account · nothing was created",
      });
    }
    const session = yield* sessionIn(project, earlier, userId, query);
    const answered =
      query.hold === "true" && unheld(session) ? yield* hold(session, userId) : session;
    return new HandoffReceived({
      session: answered,
      worktree: earlier,
      commitsAhead: admitted.commitsAhead,
      replayed: true,
      previous: null,
    });
  });

  /** Every name a worktree row or a `mend/<name>` branch in the store already holds. */
  const takenNames = Effect.fn("HandoffStart.takenNames")(function* (projectId: ProjectId) {
    const rows = yield* worktrees.listForProject(projectId);
    const refs = yield* storeRefs.list(projectId);
    return new Set([
      ...rows.map((row) => row.name),
      ...refs
        .filter((ref) => ref.name.startsWith(BRANCH_PREFIX))
        .map((ref) => ref.name.slice(BRANCH_PREFIX.length)),
    ]);
  });

  /**
   * Make the worktree under the branch's name, or the next free suffix when a name is taken
   * between the look and the create (a row, or a branch ref left by a removed worktree). A
   * unique violation on the snapshot is a replay that raced this request; it answers null.
   */
  const provision = Effect.fn("HandoffStart.provision")(function* (
    project: Project,
    userId: string,
    query: HandoffQueryInput,
    admitted: AdmittedHandoff,
  ) {
    const taken = yield* takenNames(project.id);
    const passed = new Set<string>();
    for (let attempt = 0; attempt <= NAME_TRIES; attempt += 1) {
      const name = handoffWorktreeName(
        admitted.trailers.localBranch,
        admitted.head,
        (candidate) => taken.has(candidate) || passed.has(candidate),
      );
      const outcome = yield* engine
        .provision({
          projectId: project.id,
          harness: query.harness,
          label: null,
          name,
          start: { kind: "handoff", admitted, ownerUserId: userId },
          ownerUserId: userId,
          origin: "mend",
        })
        .pipe(
          Effect.map((session): ProvisionOutcome => ({ kind: "made", session, name })),
          Effect.catchTags({
            ProjectNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
            GitError: (error): Effect.Effect<ProvisionOutcome, StoreFailure> =>
              isWorktreeNameTaken(error)
                ? Effect.succeed({ kind: "name-taken", name })
                : Effect.fail(new StoreFailure({ message: error.stderr })),
            WorktreeBaseConflictError: (): Effect.Effect<ProvisionOutcome> =>
              Effect.succeed({ kind: "name-taken", name }),
            HarnessLayoutNotAppliedError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
          }),
          Effect.catchDefect((defect): Effect.Effect<ProvisionOutcome> => {
            const constraint = uniqueViolationConstraint(defect);
            if (constraint === "worktrees_project_name_key") {
              return Effect.succeed({ kind: "name-taken", name });
            }
            return constraint === null ? Effect.die(defect) : Effect.succeed({ kind: "replayed" });
          }),
        );
      if (outcome.kind === "replayed") return null;
      if (outcome.kind === "made") {
        return {
          ...outcome,
          previous: previousOf(
            yield* worktrees.listForProject(project.id),
            outcome.name,
            userId,
            admitted,
          ),
        };
      }
      passed.add(outcome.name);
    }
    return yield* new StoreFailure({
      message: `the handoff's worktree name was taken ${NAME_TRIES + 1} times in a row · hand off again`,
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
    if (earlier === null) {
      yield* requireSessionRoom(userId, project.organizationId).pipe(
        Effect.provideService(Budgets, budgets),
        Effect.provideService(SessionsRepo, sessions),
      );
    }
    const admitted = yield* admit(project, userId, bytes);
    if (earlier !== null) return yield* replay(project, earlier, userId, query, admitted);
    const made = yield* provision(project, userId, query, admitted);
    if (made === null) {
      const raced = yield* worktrees.byHandoffCheckpoint(project.id, admitted.checkpoint);
      if (raced === null) {
        return yield* new StoreFailure({
          message: "the handoff's worktree was made elsewhere and cannot be found · hand off again",
        });
      }
      return yield* replay(project, raced, userId, query, admitted);
    }
    const worktree = yield* worktrees
      .byId(made.session.worktreeId)
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
      data: { projectId: project.id, sessionId: made.session.id },
    });
    const session = query.hold === "true" ? yield* hold(made.session, userId) : made.session;
    return new HandoffReceived({
      session,
      worktree,
      commitsAhead: admitted.commitsAhead,
      replayed: false,
      previous: made.previous,
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
    const key = `${userId}:${project.id}:${sha256Hex(bytes)}`;
    const joined = inFlight.get(key);
    if (joined !== undefined) return yield* Deferred.await(joined);
    const deferred = Deferred.makeUnsafe<HandoffReceived, HandoffError>();
    inFlight.set(key, deferred);
    // Detached, so a dropped connection ends only its wait; the slot is held for the whole
    // course, and every request for these bytes, this one included, reads the one outcome.
    yield* engine.detach(
      budgets.withHandoffSlot(userId, receive(project, userId, query, bytes)).pipe(
        Effect.flatMap((received) =>
          received === null
            ? budgetExceeded("accountHandoffsInFlight", budgets.limits)
            : Effect.succeed(received),
        ),
        Effect.onExit((exit) =>
          Effect.sync(() => {
            inFlight.delete(key);
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
      ),
    );
    return yield* Deferred.await(deferred);
  });

  return { termsAs, receiveAs };
});

export const HandoffStartLive: Layer.Layer<
  HandoffStart,
  never,
  | AgentBridge
  | AuditEventsRepo
  | Budgets
  | DeploymentConfig
  | MendKeys
  | ProjectAccess
  | SessionEngine
  | SessionsRepo
  | SourcePolicy
  | Store
  | StoreRefsRepo
  | WorktreesRepo
> = Layer.effect(HandoffStart, makeHandoffStart);
