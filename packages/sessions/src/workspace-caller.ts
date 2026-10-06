import { OrganizationsRepo, ProjectsRepo, SessionRunsRepo, SessionsRepo } from "@mend/db";
import { type ProjectId, SealantRunId, SealantWorkspaceId, type WorktreeId } from "@mend/domain";
import {
  SealantClient,
  type SealantClientShape,
  SealantPlatformError,
  SealantPrincipal,
} from "@mend/sealant";
import { Effect, Layer, Option, Stream } from "effect";
import * as Context from "effect/Context";

import { mayRunIn } from "./run-eligibility.ts";

/**
 * WHOSE PLATFORM IDENTITY A SEALANT CALL RUNS AS. One rule, applied here and nowhere else, so it
 * cannot drift (alpha 2026-10-06, 9e486cfc):
 *
 * - **A call about a workspace runs as the Mend user who created it**, whoever asks: the owner of
 *   the session whose launch made the executor (`SessionsRepo.executorSessionOf`). Core scopes a
 *   workspace, its processes and its runs to the Sealant user that created it, and answers anyone
 *   else 404. So a second person who joined a live worktree, whose session runs in the holder's
 *   executor, reaches it as the holder's owner: lookups, exec, shells, the terminal, Services,
 *   watchers, file reads, git through the workspace, checkpoints and flushes alike.
 * - **A call that spends a person's own credentials stays with that person**, the principal in
 *   context: a create (the launcher's logins go into the workspace), inference, connected
 *   accounts. A harness run started through the platform spends the logins its workspace was
 *   created with, so only the creator starts one (`refuseHarnessForOthers`).
 *
 * **Authorization stays in Mend.** Callers authorize the act first (the routes'
 * `SessionSteering`, the engine's verbs on a session they were handed). The identity is borrowed
 * only for someone with standing in that executor: they own a session in its worktree, are still a
 * member of the project's organization and can see the project (`mayRunIn`). Anyone else asks as
 * themselves and Core answers 404, so even a path that forgot to authorize reaches nothing a
 * person could not join. A principal of nobody (`none`) is never lent anyone.
 *
 * **The platform identity is plumbing, never a login.** Which login a process spends is decided
 * by the process, not by whose Sealant user opened it: in a person-layout executor (docs/adr/0016)
 * a joiner's agent, shell or Service runs as the joiner's own Linux user, whose home only ever
 * receives the joiner's own logins (decision 5). In the shared layout every process in an
 * executor runs as root with the launcher's logins, whoever started it: a joiner's agent runs on
 * the holder's login there (docs/adr/0013, "Capture mode with a joined worktree"), as it did
 * before this rule, and the rule does not change that.
 */
export class WorkspaceCaller extends Context.Service<
  WorkspaceCaller,
  {
    /**
     * Run `self`, a call about `workspaceId`, under the rule. A workspace whose creator Mend has not
     * recorded (a create not answered yet, a standby before its claim, the co-located store) is
     * asked about as the principal in context, as it always was.
     */
    readonly aboutWorkspace: (
      workspaceId: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The same for a call about a run, placed in its workspace by the session run that names it. */
    readonly aboutRun: (
      runId: string,
    ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The same for a stream about a run. */
    readonly aboutRunStream: (
      runId: string,
    ) => <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
    /**
     * Fails when the principal in context is someone other than the workspace's known creator: a
     * harness run started through the platform spends the creator's logins.
     */
    readonly refuseHarnessForOthers: (
      workspaceId: string,
    ) => Effect.Effect<void, SealantPlatformError>;
  }
>()("@mend/sessions/WorkspaceCaller") {}

interface Creator {
  readonly userId: string;
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
}

/** Run `self` as the user `lender` names; as the principal in context when it names none. */
const lent =
  (lender: Effect.Effect<string | null>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    lender.pipe(
      Effect.flatMap((userId) =>
        userId === null
          ? self
          : Effect.provideService(self, SealantPrincipal, { kind: "user", userId }),
      ),
    );

export const WorkspaceCallerLive: Layer.Layer<
  WorkspaceCaller,
  never,
  OrganizationsRepo | ProjectsRepo | SessionRunsRepo | SessionsRepo
> = Layer.effect(
  WorkspaceCaller,
  Effect.gen(function* () {
    const sessions = yield* SessionsRepo;
    const sessionRuns = yield* SessionRunsRepo;
    const projects = yield* ProjectsRepo;
    const organizations = yield* OrganizationsRepo;
    // A workspace's creator never changes, nor a run's workspace: each is read once, and only an
    // answer is kept (a creator not recorded yet is asked again next time).
    const creators = new Map<string, Creator>();
    const runWorkspaces = new Map<string, string>();

    const creatorRow = (workspaceId: string): Effect.Effect<Creator | null> =>
      Effect.suspend(() => {
        const known = creators.get(workspaceId);
        if (known !== undefined) return Effect.succeed(known);
        return sessions.executorSessionOf(SealantWorkspaceId.make(workspaceId)).pipe(
          Effect.map((session) => {
            if (session === null || session.ownerUserId === null) return null;
            const creator: Creator = {
              userId: session.ownerUserId,
              worktreeId: session.worktreeId,
              projectId: session.projectId,
            };
            creators.set(workspaceId, creator);
            return creator;
          }),
        );
      });

    /** Whether `userId` may work in the executor `creator` launched (see the class's comment). */
    const hasStanding = (userId: string, creator: Creator): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const here = yield* sessions.listForWorktree(creator.worktreeId);
        if (!here.some((session) => session.ownerUserId === userId)) return false;
        const project = yield* projects.byId(creator.projectId).pipe(Effect.option);
        if (Option.isNone(project)) return false;
        return yield* mayRunIn(organizations, project.value, userId);
      });

    /** Who a call about `workspaceId` runs as: a creator to borrow, or null for the principal. */
    const lenderFor = (workspaceId: string): Effect.Effect<string | null> =>
      Effect.gen(function* () {
        const principal = yield* SealantPrincipal;
        if (principal.kind === "none") return null;
        const creator = yield* creatorRow(workspaceId);
        if (creator === null || creator.userId === principal.userId) return null;
        if (yield* hasStanding(principal.userId, creator)) return creator.userId;
        yield* Effect.logDebug(
          "workspace caller: asked as themselves · no standing in the creator's executor",
        ).pipe(Effect.annotateLogs({ workspaceId, asker: principal.userId }));
        return null;
      });

    const runWorkspace = (runId: string): Effect.Effect<string | null> =>
      Effect.suspend(() => {
        const known = runWorkspaces.get(runId);
        if (known !== undefined) return Effect.succeed(known);
        return sessionRuns.bySealantRunId(SealantRunId.make(runId)).pipe(
          Effect.map((run) => {
            if (run === null) return null;
            runWorkspaces.set(runId, run.sealantWorkspaceId);
            return run.sealantWorkspaceId;
          }),
        );
      });

    const runLender = (runId: string) =>
      runWorkspace(runId).pipe(
        Effect.flatMap((workspaceId) =>
          workspaceId === null ? Effect.succeed(null) : lenderFor(workspaceId),
        ),
      );

    return {
      aboutWorkspace: (workspaceId) => lent(lenderFor(workspaceId)),
      aboutRun: (runId) => lent(runLender(runId)),
      aboutRunStream:
        (runId) =>
        <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
          Stream.unwrap(
            runLender(runId).pipe(
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
          const creator = yield* creatorRow(workspaceId);
          if (creator === null || principal.kind === "none") return;
          if (creator.userId === principal.userId) return;
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
  const about = caller.aboutWorkspace;
  const harness = <A>(workspaceId: string, self: Effect.Effect<A, SealantPlatformError>) =>
    caller.refuseHarnessForOthers(workspaceId).pipe(Effect.andThen(self));
  return {
    // A person's own: the creator is whoever creates, and the launcher's logins go in.
    createWorkspace: (options, launch, watch) => client.createWorkspace(options, launch, watch),
    // A create key belongs to the person who created under it; callers ask as them.
    findWorkspaceByKey: (key) => client.findWorkspaceByKey(key),
    fenceWorkspaceCreate: (key) => client.fenceWorkspaceCreate(key),
    getWorkspace: (id) => about(id)(client.getWorkspace(id)),
    getRun: (runId) => caller.aboutRun(runId)(client.getRun(runId)),
    // A harness run spends the workspace's logins: its creator's alone.
    runHarness: (workspace, prompt, options) =>
      harness(workspace.id, client.runHarness(workspace, prompt, options)),
    startHarness: (workspace, prompt, options) =>
      harness(workspace.id, client.startHarness(workspace, prompt, options)),
    startHarnessInWorkspace: (workspaceId, harnessId, prompt) =>
      harness(workspaceId, client.startHarnessInWorkspace(workspaceId, harnessId, prompt)),
    waitRun: (run) => caller.aboutRun(run.id)(client.waitRun(run)),
    openSession: (workspace, argv, options) =>
      about(workspace.id)(client.openSession(workspace, argv, options)),
    forward: (workspace, port, host, protocol) =>
      about(workspace.id)(client.forward(workspace, port, host, protocol)),
    stopWorkspace: (workspace, options) =>
      about(workspace.id)(client.stopWorkspace(workspace, options)),
    runtimeResourceId: (workspace, launchId) =>
      about(workspace.id)(client.runtimeResourceId(workspace, launchId)),
    captureFlush: (workspace, kind) => about(workspace.id)(client.captureFlush(workspace, kind)),
    captureStatus: (workspace) => about(workspace.id)(client.captureStatus(workspace)),
    captureReplan: (workspace) => about(workspace.id)(client.captureReplan(workspace)),
    runtimeDeadline: (workspace) => about(workspace.id)(client.runtimeDeadline(workspace)),
    expireWorkspace: (workspaceId, ttlSeconds) =>
      about(workspaceId)(client.expireWorkspace(workspaceId, ttlSeconds)),
    getSession: (workspace, sessionId) =>
      about(workspace.id)(client.getSession(workspace, sessionId)),
    // Addressed by a PTY id alone, which this cannot place: callers name the workspace
    // (`WorkspaceCaller.aboutWorkspace`), as the process logs route does.
    sessionOutput: (sessionId, options) => client.sessionOutput(sessionId, options),
    exec: (workspace, argv, options) => about(workspace.id)(client.exec(workspace, argv, options)),
    bindWorkspace: (workspace, options) =>
      about(workspace.id)(client.bindWorkspace(workspace, options)),
    diffCommits: (workspaceId, base, head) =>
      about(workspaceId)(client.diffCommits(workspaceId, base, head)),
    // The asker's own login (ADR 0008): never borrowed.
    inferenceRespond: (options) => client.inferenceRespond(options),
    recordStream: (run, options) =>
      caller.aboutRunStream(run.id)(client.recordStream(run, options)),
    recordTimeline: (run, options) =>
      caller.aboutRunStream(run.id)(client.recordTimeline(run, options)),
    recordCommands: (run) => caller.aboutRun(run.id)(client.recordCommands(run)),
    recordScrollback: (run, processId, stream) =>
      caller.aboutRun(run.id)(client.recordScrollback(run, processId, stream)),
    runChanges: (run) => caller.aboutRun(run.id)(client.runChanges(run)),
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
