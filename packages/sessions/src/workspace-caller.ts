import { type ExecutorAccess, SessionRunsRepo, SessionsRepo } from "@mend/db";
import { SealantRunId, SealantWorkspaceId } from "@mend/domain";
import { canSeeProject, type OrganizationRole, type ProjectTenancy } from "@mend/domain/workbench";
import {
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
  SealantPrincipal,
} from "@mend/sealant";
import { Effect, Layer, Stream } from "effect";
import * as Context from "effect/Context";

/**
 * WHOSE PLATFORM IDENTITY A SEALANT CALL RUNS AS. One rule, applied here and nowhere else, so it
 * cannot drift (alpha 2026-10-06, 9e486cfc). Core scopes a workspace, its processes and its runs
 * to the Sealant user that created it, and answers anyone else 404; the creator is the owner of
 * the session whose own launch made the executor (`SessionsRepo.executorSessionOf`).
 *
 * - **Observing and ending run as the creator, for any named person, unconditionally:** looking a
 *   workspace, a PTY or a run up, reading a record, flushing captures, stopping the workspace.
 *   These only read what Mend already holds or take access away (closing a process is a lookup
 *   and a close on its handle), so they never depend on whether the asker may still work there.
 *   Above all, a 404 seen by someone who lost access is never read as "the executor is gone":
 *   liveness, removal and project-removal checks see what the creator sees (mend#558 review,
 *   P1-1, P2).
 * - **Acting in a workspace is lent only while both people may work there:** exec, a new PTY or
 *   pipe, a forward, a bind, a replan, a TTL renewal, a git read. The asker must still be a member
 *   of the project's organization who can see the project (`canSeeProject`), and the creator must
 *   still be a member of it, both read in one query (`SessionsRepo.executorAccessOf`). Otherwise
 *   the act is refused here (403), never handed to Core as the asker: a handle the creator
 *   fetched would run it anyway. A creator who is no longer a member lends nothing: their
 *   executor is retired (`SessionEngine.windDownPerson`, `reconcileAccess`), and joiners start
 *   their own. A creator who is still a member keeps their executor whatever they can see: a
 *   project going private leaves their own sessions running, as the setting says.
 * - **A call that spends a person's own credentials stays with that person**, the principal in
 *   context: a create (the launcher's logins go into the workspace), inference, create keys. A
 *   harness run through the platform spends the logins its workspace was created with, so only
 *   the creator starts one (`refuseHarnessForOthers`; today only the retired queue calls it).
 * - A principal of nobody (`none`) is never lent anyone, and a workspace whose creator Mend has
 *   not recorded (a create not answered yet, a standby before its claim, the co-located store)
 *   is asked about as the principal in context, as it always was.
 *
 * **Authorization stays in Mend.** Callers authorize the act first (the routes' `SessionSteering`
 * and `ProjectAccess`, the engine's verbs on a session they were handed). Any member who can see a
 * project may start a session in a worktree and join its executor, so having a session there is
 * not part of the check: it would gate nothing a join does not already allow.
 *
 * **The platform identity is plumbing, never a login.** Which login a process spends is decided by
 * the process, not by whose Sealant user opened it: in a person-layout executor (docs/adr/0016) a
 * joiner's agent, shell or Service runs as the joiner's own Linux user, whose home only ever
 * receives the joiner's own logins (decision 5). In the shared layout every process in an executor
 * runs as root with the launcher's logins and GitHub token, whoever started it, and git through
 * its socket signs as the launcher (docs/adr/0013, "Capture mode with a joined worktree"). The
 * owner accepted that until per-person homes ship (2026-10-06); the rule does not change it.
 */
export class WorkspaceCaller extends Context.Service<
  WorkspaceCaller,
  {
    /** Run `self`, which observes or ends something of `workspaceId`, under the rule. */
    readonly observe: (
      workspaceId: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Run `self`, which acts in `workspaceId`, under the rule: refused without standing. */
    readonly act: (
      workspaceId: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SealantPlatformError, R>;
    /** `observe` for a run, placed in its workspace by the session run that names it. */
    readonly observeRun: (
      runId: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The same for a stream about a run. */
    readonly observeRunStream: (
      runId: string,
    ) => <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
    /**
     * Succeeds when the principal in context may act in `workspaceId` (the act rule, with nothing
     * run): what a caller checks before input reaches a process that already exists, such as a
     * terminal attached for typing.
     */
    readonly mayAct: (workspaceId: string) => Effect.Effect<void, SealantPlatformError>;
    /** The Mend user Mend recorded as `workspaceId`'s creator; null when none is recorded. */
    readonly creatorOf: (workspaceId: string) => Effect.Effect<string | null>;
    /**
     * Mend just recorded `userId` as the creator of `workspaceId` (an accepted create or a
     * claimed standby): an earlier "none on record" no longer stands (mend#558 review 2, P2-2).
     */
    readonly recorded: (workspaceId: string, userId: string | null) => Effect.Effect<void>;
    /**
     * Fails when the principal in context is someone other than the workspace's known creator: a
     * harness run started through the platform spends the creator's logins.
     */
    readonly refuseHarnessForOthers: (
      workspaceId: string,
    ) => Effect.Effect<void, SealantPlatformError>;
  }
>()("@mend/sessions/WorkspaceCaller") {}

/** How long "no creator on record" is believed before it is asked again. */
const UNKNOWN_CREATOR_MS = 10_000;
/** Past this many entries a cache starts over: bounded for a long-lived server. */
const CACHE_ENTRIES = 10_000;

/** Run `self` as `userId`; as the principal in context when it is null. */
const as =
  (userId: string | null) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    userId === null
      ? self
      : Effect.provideService(self, SealantPrincipal, { kind: "user", userId });

const asLent =
  (lender: Effect.Effect<string | null>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(lender, (userId) => as(userId)(self));

/** Whether `userId`, with `role` in the project's organization, may work in its executors. */
export const mayWorkIn = (role: OrganizationRole | null, userId: string, project: ProjectTenancy) =>
  role !== null && canSeeProject(project, { userId, organizationId: project.organizationId, role });

/**
 * Why an act in another person's executor is not lent, in the words the session line and the
 * refusal carry; null when it is. Existing sessions in their own executor have a separate
 * lifetime rule: a visibility change does not end them.
 */
export const actRefusal = (access: ExecutorAccess, asker: string): SealantPlatformError | null => {
  if (!mayWorkIn(access.askerRole, asker, access.project)) {
    return new SealantPlatformError({
      code: "no_standing",
      status: 403,
      message:
        "you no longer have access to this project, so nothing runs for you in its workspaces",
      cause: null,
    });
  }
  // A creator who is still a member lends their executor whatever they can see: their own
  // sessions keep running in it when the project goes private (review 3 of mend#558, P1).
  if (access.creatorRole === null) {
    return new SealantPlatformError({
      code: "creator_no_access",
      status: 403,
      message:
        "the person who started this workspace is no longer a member of this organization, so nothing new runs in it · start a session of your own in this worktree",
      cause: null,
    });
  }
  return null;
};

const remember = <V>(cache: Map<string, V>, key: string, value: V) => {
  if (cache.size >= CACHE_ENTRIES) cache.clear();
  cache.set(key, value);
};

export const WorkspaceCallerLive: Layer.Layer<
  WorkspaceCaller,
  never,
  SessionRunsRepo | SessionsRepo
> = Layer.effect(
  WorkspaceCaller,
  Effect.gen(function* () {
    const sessions = yield* SessionsRepo;
    const sessionRuns = yield* SessionRunsRepo;
    // A workspace's creator never changes, nor a run's workspace: an answer is kept for good, "none
    // on record" for `UNKNOWN_CREATOR_MS` (the co-located store records none, ever).
    const creators = new Map<string, string>();
    const unknownSince = new Map<string, number>();
    const runWorkspaces = new Map<string, string>();

    /** `trustUnknown` false: an act never rests on a cached "none on record" (review 2, P2-2). */
    const creatorOf = (workspaceId: string, trustUnknown = true): Effect.Effect<string | null> =>
      Effect.suspend(() => {
        const known = creators.get(workspaceId);
        if (known !== undefined) return Effect.succeed(known);
        const since = unknownSince.get(workspaceId);
        if (trustUnknown && since !== undefined && Date.now() - since < UNKNOWN_CREATOR_MS) {
          return Effect.succeed(null);
        }
        return sessions.executorSessionOf(SealantWorkspaceId.make(workspaceId)).pipe(
          Effect.map((session) => {
            const userId = session?.ownerUserId ?? null;
            if (userId === null) {
              remember(unknownSince, workspaceId, Date.now());
              return null;
            }
            unknownSince.delete(workspaceId);
            remember(creators, workspaceId, userId);
            return userId;
          }),
        );
      });

    /** Observing and ending: the creator, for any named person. */
    const observer = (workspaceId: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const principal = yield* SealantPrincipal;
        if (principal.kind === "none") return null;
        const creator = yield* creatorOf(workspaceId);
        return creator === null || creator === principal.userId ? null : creator;
      });

    /** Acting: the creator, while both may work there; refused otherwise. */
    const actor = (
      workspaceId: string,
      trustUnknown = false,
    ): Effect.Effect<string | null, SealantPlatformError> =>
      Effect.gen(function* () {
        const principal = yield* SealantPrincipal;
        if (principal.kind === "none") return null;
        const creator = yield* creatorOf(workspaceId, trustUnknown);
        if (creator === null || creator === principal.userId) return null;
        const access = yield* sessions.executorAccessOf(
          SealantWorkspaceId.make(workspaceId),
          principal.userId,
        );
        if (access === null) return null;
        const refusal = actRefusal(access, principal.userId);
        if (refusal === null) return access.creatorUserId;
        yield* Effect.logInfo(
          "workspace caller: an act in another person's workspace refused",
        ).pipe(Effect.annotateLogs({ workspaceId, asker: principal.userId, code: refusal.code }));
        return yield* refusal;
      });

    const runWorkspace = (runId: string): Effect.Effect<string | null> =>
      Effect.suspend(() => {
        const known = runWorkspaces.get(runId);
        if (known !== undefined) return Effect.succeed(known);
        return sessionRuns.bySealantRunId(SealantRunId.make(runId)).pipe(
          Effect.map((run) => {
            if (run === null) return null;
            remember(runWorkspaces, runId, run.sealantWorkspaceId);
            return run.sealantWorkspaceId;
          }),
        );
      });

    const runObserver = (runId: string) =>
      runWorkspace(runId).pipe(
        Effect.flatMap((workspaceId) =>
          workspaceId === null ? Effect.succeed(null) : observer(workspaceId),
        ),
      );

    return {
      creatorOf: (workspaceId) => creatorOf(workspaceId),
      recorded: (workspaceId, userId) =>
        Effect.sync(() => {
          unknownSince.delete(workspaceId);
          if (userId !== null) remember(creators, workspaceId, userId);
        }),
      // A check before input on every terminal attach: a cached "none on record" stands (the
      // co-located store never records one), so it costs no query there (review 3, P3-6). The
      // act itself still re-reads it.
      mayAct: (workspaceId) => Effect.asVoid(actor(workspaceId, true)),
      observe: (workspaceId) => asLent(observer(workspaceId)),
      act:
        (workspaceId) =>
        <A, E, R>(self: Effect.Effect<A, E, R>) =>
          Effect.flatMap(actor(workspaceId), (userId) => as(userId)(self)),
      observeRun: (runId) => asLent(runObserver(runId)),
      observeRunStream:
        (runId) =>
        <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
          Stream.unwrap(
            runObserver(runId).pipe(
              Effect.map((userId) =>
                userId === null
                  ? self
                  : self.pipe(Stream.provideService(SealantPrincipal, { kind: "user", userId })),
              ),
            ),
          ),
      refuseHarnessForOthers: (workspaceId) =>
        Effect.gen(function* () {
          const principal = yield* SealantPrincipal;
          const creator = yield* creatorOf(workspaceId);
          if (creator === null || principal.kind === "none") return;
          if (creator === principal.userId) return;
          return yield* new SealantPlatformError({
            code: "harness_login_not_yours",
            status: 403,
            message:
              "a harness run in this workspace spends the logins it was created with, which are another person's; only they start one",
            cause: null,
          });
        }),
    };
  }),
);

/**
 * `SealantClient` under the rule (`WorkspaceCaller`). Every method is listed, none spread, so a
 * method added to the client fails to compile here until someone decides which side of the rule
 * it is on.
 */
export const byWorkspaceCreator = (
  client: SealantClientShape,
  caller: WorkspaceCaller["Service"],
): SealantClientShape => {
  const look = caller.observe;
  const act = caller.act;
  const run = caller.observeRun;
  const runStream = caller.observeRunStream;
  const harness = <A>(workspaceId: string, self: Effect.Effect<A, SealantPlatformError>) =>
    caller.refuseHarnessForOthers(workspaceId).pipe(Effect.andThen(self));
  return {
    // A person's own: the creator is whoever creates, and the launcher's logins go in.
    createWorkspace: (options, launch, watch) => client.createWorkspace(options, launch, watch),
    // A create key belongs to the person who created under it; callers ask as them.
    findWorkspaceByKey: (key) => client.findWorkspaceByKey(key),
    fenceWorkspaceCreate: (key) => client.fenceWorkspaceCreate(key),
    // Observing and ending: as the creator, whatever the asker's standing.
    getWorkspace: (id) => look(id)(client.getWorkspace(id)),
    getSession: (workspace, sessionId) =>
      look(workspace.id)(client.getSession(workspace, sessionId)),
    stopWorkspace: (workspace, options) =>
      look(workspace.id)(client.stopWorkspace(workspace, options)),
    captureFlush: (workspace, kind) => look(workspace.id)(client.captureFlush(workspace, kind)),
    captureStatus: (workspace) => look(workspace.id)(client.captureStatus(workspace)),
    runtimeDeadline: (workspace) => look(workspace.id)(client.runtimeDeadline(workspace)),
    runtimeResourceId: (workspace, launchId) =>
      look(workspace.id)(client.runtimeResourceId(workspace, launchId)),
    getRun: (runId) => run(runId)(client.getRun(runId)),
    waitRun: (sdkRun) => run(sdkRun.id)(client.waitRun(sdkRun)),
    recordStream: (sdkRun, options) => runStream(sdkRun.id)(client.recordStream(sdkRun, options)),
    recordTimeline: (sdkRun, options) =>
      runStream(sdkRun.id)(client.recordTimeline(sdkRun, options)),
    recordCommands: (sdkRun) => run(sdkRun.id)(client.recordCommands(sdkRun)),
    recordScrollback: (sdkRun, processId, stream) =>
      run(sdkRun.id)(client.recordScrollback(sdkRun, processId, stream)),
    runChanges: (sdkRun) => run(sdkRun.id)(client.runChanges(sdkRun)),
    // Addressed by a PTY id alone, which this cannot place: callers name the workspace
    // (`WorkspaceCaller.observe`), as the process logs route does.
    sessionOutput: (sessionId, options) => client.sessionOutput(sessionId, options),
    // Acting: lent only while both people may work there, refused otherwise.
    openSession: (workspace, argv, options) =>
      act(workspace.id)(client.openSession(workspace, argv, options)),
    exec: (workspace, argv, options) => act(workspace.id)(client.exec(workspace, argv, options)),
    forward: (workspace, port, host, protocol) =>
      act(workspace.id)(client.forward(workspace, port, host, protocol)),
    bindWorkspace: (workspace, options) =>
      act(workspace.id)(client.bindWorkspace(workspace, options)),
    captureReplan: (workspace, options) =>
      act(workspace.id)(client.captureReplan(workspace, options)),
    expireWorkspace: (workspaceId, ttlSeconds) =>
      act(workspaceId)(client.expireWorkspace(workspaceId, ttlSeconds)),
    diffCommits: (workspaceId, base, head) =>
      act(workspaceId)(client.diffCommits(workspaceId, base, head)),
    // A harness run spends the workspace's logins: its creator's alone.
    runHarness: (workspace, prompt, options) =>
      harness(workspace.id, client.runHarness(workspace, prompt, options)),
    startHarness: (workspace, prompt, options) =>
      harness(workspace.id, client.startHarness(workspace, prompt, options)),
    startHarnessInWorkspace: (workspaceId, harnessId, prompt) =>
      harness(workspaceId, client.startHarnessInWorkspace(workspaceId, harnessId, prompt)),
    // The asker's own login (ADR 0008): never borrowed.
    inferenceRespond: (options) => client.inferenceRespond(options),
    connectionCheck: () => client.connectionCheck(),
    resolveWorkspacePackage: (packageName, os) => client.resolveWorkspacePackage(packageName, os),
  };
};

/**
 * The client every part of the server reaches the platform through, under the rule: it replaces
 * the dispatching `SealantClient` it is given (compose with `Layer.provideMerge`, so the clients
 * beneath stay available).
 */
export const SealantClientByWorkspaceCreator: Layer.Layer<
  SealantClient,
  never,
  SealantClient | WorkspaceCaller
> = Layer.effect(
  SealantClient,
  Effect.gen(function* () {
    const client = yield* SealantClient;
    const caller = yield* WorkspaceCaller;
    return byWorkspaceCreator(client, caller);
  }),
);
