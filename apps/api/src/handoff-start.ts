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
  type WorktreeHandoff,
} from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
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

const NAME_TRIES = 5;

type ProvisionOutcome =
  | { readonly kind: "made"; readonly session: Session }
  | { readonly kind: "name-taken"; readonly name: string }
  | { readonly kind: "replayed" };

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

const BRANCH_PREFIX = "refs/heads/mend/";

/** The newest of the account's handoffs of `localBranch` among the names this one passed over. */
const previousOf = (
  rows: ReadonlyArray<Worktree>,
  passed: ReadonlySet<string>,
  userId: string,
  localBranch: string | null,
): string | null =>
  rows
    .filter(
      (row) =>
        passed.has(row.name) &&
        row.handoff !== null &&
        row.handoff.ownerUserId === userId &&
        row.handoff.localBranch !== null &&
        row.handoff.localBranch === localBranch,
    )
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .at(0)?.name ?? null;

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
    const own = (yield* sessions.listForWorktree(worktree.id))
      .filter((session) => session.ownerUserId === userId)
      .at(-1);
    return (
      own ??
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

  /** The account's earlier receipt of the same W, answered from what it stored then. */
  const replay = Effect.fn("HandoffStart.replay")(function* (
    project: Project,
    earlier: Worktree,
    seed: WorktreeHandoff,
    userId: string,
    query: HandoffQueryInput,
  ) {
    const session = yield* sessionIn(project, earlier, userId, query);
    const answered =
      query.hold === "true" && unheld(session) ? yield* hold(session, userId) : session;
    return new HandoffReceived({
      session: answered,
      worktree: earlier,
      commitsAhead: seed.commitsAhead,
      replayed: true,
      previous: seed.previous === null ? null : { name: seed.previous },
    });
  });

  const foreign = new StoreFailure({
    message: "this handoff was received before, for another account · nothing was created",
  });

  const takenNames = Effect.fn("HandoffStart.takenNames")(function* (projectId: ProjectId) {
    const rows = yield* worktrees.listForProject(projectId);
    const refs = yield* storeRefs.list(projectId);
    const taken = new Set([
      ...rows.map((row) => row.name),
      ...refs
        .filter((ref) => ref.name.startsWith(BRANCH_PREFIX))
        .map((ref) => ref.name.slice(BRANCH_PREFIX.length)),
    ]);
    return { rows, taken };
  });

  const provision = Effect.fn("HandoffStart.provision")(function* (
    project: Project,
    userId: string,
    query: HandoffQueryInput,
    admitted: AdmittedHandoff,
  ) {
    const { rows, taken } = yield* takenNames(project.id);
    const localBranch = admitted.trailers.localBranch;
    // Every name passed over, taken before the look or lost to another create since.
    const passed = new Set<string>();
    for (let attempt = 0; attempt <= NAME_TRIES; attempt += 1) {
      const name = handoffWorktreeName(localBranch, admitted.head, (candidate) => {
        if (taken.has(candidate)) passed.add(candidate);
        return passed.has(candidate);
      });
      const previous = previousOf(rows, passed, userId, localBranch);
      const outcome = yield* engine
        .provision({
          projectId: project.id,
          harness: query.harness,
          label: null,
          name,
          start: { kind: "handoff", admitted, ownerUserId: userId, previous },
          ownerUserId: userId,
          origin: "mend",
        })
        .pipe(
          Effect.map((session): ProvisionOutcome => ({ kind: "made", session })),
          Effect.catchTags({
            ProjectNotFoundError: () => Effect.fail(new NotFound({ id: project.id })),
            GitError: (error) => Effect.fail(new StoreFailure({ message: error.stderr })),
            WorktreeNameTakenError: (): Effect.Effect<ProvisionOutcome> =>
              Effect.succeed({ kind: "name-taken", name }),
            WorktreeBaseConflictError: (): Effect.Effect<ProvisionOutcome> =>
              Effect.succeed({ kind: "name-taken", name }),
            WorktreeStartUnsupportedError: (error) =>
              Effect.fail(refused("store-co-located", error.message)),
            HarnessLayoutNotAppliedError: (error) =>
              Effect.fail(new StoreFailure({ message: error.message })),
          }),
          Effect.catchDefect((defect): Effect.Effect<ProvisionOutcome> => {
            const constraint = uniqueViolationConstraint(defect);
            if (constraint === "worktrees_project_name_key") {
              return Effect.succeed({ kind: "name-taken", name });
            }
            return constraint === "worktrees_project_handoff_checkpoint_key"
              ? Effect.succeed({ kind: "replayed" })
              : Effect.die(defect);
          }),
        );
      if (outcome.kind === "replayed") return null;
      if (outcome.kind === "made") return { session: outcome.session, previous };
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
    snapshot: Sha | null,
  ) {
    const earlier =
      snapshot === null ? null : yield* worktrees.byHandoffCheckpoint(project.id, snapshot);
    if (earlier !== null && earlier.handoff !== null) {
      if (earlier.handoff.ownerUserId === userId) {
        return yield* replay(project, earlier, earlier.handoff, userId, query);
      }
      // Bytes that only name another account's W are verified before anything is said of it.
      yield* admit(project, userId, bytes);
      return yield* foreign;
    }
    yield* requireSessionRoom(userId, project.organizationId).pipe(
      Effect.provideService(Budgets, budgets),
      Effect.provideService(SessionsRepo, sessions),
    );
    const admitted = yield* admit(project, userId, bytes);
    const made = yield* provision(project, userId, query, admitted);
    if (made === null) {
      const raced = yield* worktrees.byHandoffCheckpoint(project.id, admitted.snapshot);
      if (raced === null || raced.handoff === null) {
        return yield* new StoreFailure({
          message: "the handoff's worktree was made elsewhere and cannot be found · hand off again",
        });
      }
      if (raced.handoff.ownerUserId !== userId) return yield* foreign;
      return yield* replay(project, raced, raced.handoff, userId, query);
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
      previous: made.previous === null ? null : { name: made.previous },
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
    const header = parseBundleHeader(bytes)?.refs[0]?.sha;
    const snapshot = header === undefined ? null : Sha.make(header);
    // One receipt of a W per account at a time, whatever bytes carry it: the database dedupes on
    // W, and so does this join.
    const key = `${userId}:${project.id}:${snapshot ?? sha256Hex(bytes)}`;
    const joined = inFlight.get(key);
    if (joined !== undefined) return yield* Deferred.await(joined);
    const deferred = Deferred.makeUnsafe<HandoffReceived, HandoffError>();
    inFlight.set(key, deferred);
    yield* engine.detach(
      budgets.withHandoffSlot(userId, receive(project, userId, query, bytes, snapshot)).pipe(
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
