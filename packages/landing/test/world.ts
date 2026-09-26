import {
  ChangeLandingsRepo,
  ChangeToursRepo,
  type NewChangeLanding,
  ProjectsRepo,
  SessionGitOpsRepo,
  SessionProcessesRepo,
  SessionsRepo,
  UsersRepo,
  UserFacts,
  WorktreeChangesRepo,
  WorktreesRepo,
} from "@mend/db";
import {
  ChangeId,
  ChangeLandingId,
  CheckpointId,
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionGitOpId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  Change,
  ChangeLanding,
  ChangeTour,
  Checkpoint,
  type LandedPullRequest,
  Project,
  Session,
  SessionProcess,
  Worktree,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";

/**
 * One session's world for landing tests: the project, worktree, session and change rows, the
 * owner's account, an optional tour, and an in-memory `change_landings` table that keeps the
 * rows the way the repository does (newest first, the outcome's facts only).
 */

export const NOW = new Date("2026-09-24T10:00:00Z");
export const OWNER = "ada";
export const BASE_SHA = Sha.make("1111111111111111111111111111111111111111");

export interface WorldOptions {
  readonly storePath?: string;
  readonly originUrl?: string | null;
  readonly ownerUserId?: string | null;
  readonly label?: string | null;
  readonly branch?: string;
  readonly directory?: string;
  readonly baseSha?: Sha;
  readonly baseRef?: string | null;
  readonly tour?: { readonly summary: string; readonly approach: string | null } | null;
  readonly users?: ReadonlyArray<UserFacts>;
  /**
   * Other sessions in the same worktree, as a teammate who joined it starts them. The change's
   * owner is whoever owns the earliest session.
   */
  readonly siblings?: ReadonlyArray<{
    readonly id: string;
    readonly ownerUserId: string | null;
    readonly createdAt: Date;
  }>;
  /** The worktree's head as the change last saw it; null (the default) never refreshed. */
  readonly headSha?: Sha | null;
  /** `ref_updates` of the pushes the agent made itself through the transport. */
  readonly agentPushes?: ReadonlyArray<ReadonlyArray<string>>;
  /** Whether the session holds a live process: a workspace `gh` can run in. */
  readonly live?: boolean;
}

export const makeWorld = (options: WorldOptions = {}) => {
  const projectId = ProjectId.make("p-api");
  const worktreeId = WorktreeId.make("wt-1");
  const sessionId = SessionId.make("22222222-2222-2222-2222-222222222222");
  const changeId = ChangeId.make("c-1");
  const branch = options.branch ?? "mend/fix-login";
  const baseSha = options.baseSha ?? BASE_SHA;
  const project = new Project({
    id: projectId,
    name: "api",
    organizationId: OrganizationId.make("org-acme"),
    visibility: "shared",
    createdByUserId: OWNER,
    originUrl: options.originUrl === undefined ? "git@github.com:acme/api.git" : options.originUrl,
    storePath: options.storePath ?? "/store/p-api/repo.git",
    defaultBranch: "main",
    adoptedSha: baseSha,
    autoTour: "inherit",
    autoSuggest: "inherit",
    autoName: "inherit",
    autoLand: "inherit",
    backgroundSessions: "inherit",
    gitAuthMode: "ambient",
    workspaceImage: null,
    applyDotfiles: false,
    defaultShellProfile: true,
    inheritUserSkills: true,
    hotSessions: 0,
    installCommand: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const worktree = new Worktree({
    id: worktreeId,
    projectId,
    name: "fix-login",
    directory: options.directory ?? "wt-1",
    branch,
    baseSha,
    baseRef: options.baseRef === undefined ? "main" : options.baseRef,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const session = new Session({
    id: sessionId,
    projectId,
    worktreeId,
    harness: "claude",
    providerSessionId: null,
    label: options.label === undefined ? "login loop" : options.label,
    worktree: worktree.directory,
    branch,
    baseSha,
    baseRef: worktree.baseRef,
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: null,
    sealantWorkspaceId: null,
    sealantSessionId: null,
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: options.ownerUserId === undefined ? OWNER : options.ownerUserId,
    hasTranscript: true,
    status: "idle",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const siblings = (options.siblings ?? []).map(
    (sibling) =>
      new Session({
        ...session,
        id: SessionId.make(sibling.id),
        ownerUserId: sibling.ownerUserId,
        createdAt: sibling.createdAt,
      }),
  );
  /** Every session in the worktree, newest first, as `listForWorktree` returns them. */
  const worktreeSessions = [session, ...siblings].toSorted(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const change = new Change({
    id: changeId,
    projectId,
    worktreeId,
    sessionId,
    branch,
    baseSha,
    headSha: options.headSha ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const tour =
    options.tour === undefined || options.tour === null
      ? null
      : new ChangeTour({
          id: "tour-1",
          changeId,
          sessionId,
          summary: options.tour.summary,
          approach: options.tour.approach,
          stops: [],
          diffDigest: "digest",
          createdAt: NOW,
        });
  const users = new Map(
    (
      options.users ?? [new UserFacts({ id: OWNER, name: "Ada Owner", email: "ada@example.com" })]
    ).map((user) => [user.id, user]),
  );

  /** The `change_landings` rows, newest first. */
  const landings: Array<ChangeLanding> = [];
  /** Which tour each landing's pull request was last described with after the tour completed. */
  const describedTours = new Map<string, string>();
  const toRow = (landing: NewChangeLanding): ChangeLanding => {
    const result = landing.result;
    return new ChangeLanding({
      id: ChangeLandingId.make(`landing-${landings.length + 1}`),
      changeId: landing.changeId,
      sessionId: landing.sessionId,
      projectId: landing.projectId,
      checkpointId: landing.checkpoint?.id ?? null,
      checkpointRef: landing.checkpoint?.ref ?? null,
      checkpointSha: landing.checkpoint?.sha ?? null,
      commitSha: landing.commitSha,
      remoteBranch: landing.remoteBranch,
      pushedSha:
        result.outcome === "refused" || result.outcome === "adopted" ? null : result.pushedSha,
      trigger: landing.trigger,
      pullRequest:
        result.outcome === "pull-request" || result.outcome === "adopted"
          ? result.pullRequest
          : null,
      pullRequestCrossRepository: result.outcome === "adopted" ? result.crossRepository : false,
      pullRequestHeadOwner: result.outcome === "adopted" ? result.headOwner : null,
      outcome: result.outcome,
      message: result.outcome === "refused" || result.outcome === "failed" ? result.message : null,
      userId: landing.userId,
      createdAt: new Date(NOW.getTime() + landings.length * 1000),
    });
  };

  const repos = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      byId: (id) =>
        Effect.succeed(worktreeSessions.find((candidate) => candidate.id === id) ?? session),
      listForWorktree: () => Effect.succeed(worktreeSessions),
    }),
    Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
    Layer.mock(WorktreesRepo, { byId: () => Effect.succeed(worktree) }),
    Layer.mock(WorktreeChangesRepo, {
      byWorktree: () => Effect.succeed(change),
      byId: () => Effect.succeed(change),
    }),
    Layer.mock(ChangeToursRepo, { byChange: () => Effect.succeed(tour) }),
    Layer.mock(UsersRepo, { byId: (id) => Effect.succeed(users.get(id) ?? null) }),
    Layer.mock(SessionGitOpsRepo, {
      listForSession: (id) =>
        Effect.succeed(
          id !== sessionId
            ? []
            : (options.agentPushes ?? []).map((refUpdates, index) => ({
                id: SessionGitOpId.make(`op-${index}`),
                sessionId,
                projectId,
                host: "github.com",
                port: null,
                kind: "push" as const,
                command: "git-receive-pack 'acme/api.git'",
                authMode: "mend-key" as const,
                refUpdates: [...refUpdates],
                exitCode: 0,
                startedAt: new Date(NOW.getTime() - index * 1000),
                finishedAt: new Date(NOW.getTime() - index * 1000),
              })),
        ),
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSessions: (ids) =>
        Effect.succeed(
          options.live === true && ids.includes(sessionId)
            ? [
                new SessionProcess({
                  id: SessionProcessId.make("agent-1"),
                  sessionId,
                  sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
                  sealantSessionId: "pty-1",
                  sealantRunId: null,
                  launchCorrelationId: null,
                  serviceId: null,
                  attemptOrdinal: null,
                  kind: "agent-pty",
                  harness: "claude",
                  providerSessionId: null,
                  protocolOptions: null,
                  label: "claude",
                  argv: ["claude"],
                  status: "running",
                  exitCode: null,
                  workspacePort: null,
                  protocol: "tcp",
                  hostPort: null,
                  createdAt: NOW,
                  exitedAt: null,
                  updatedAt: NOW,
                }),
              ]
            : [],
        ),
    }),
    Layer.succeed(ChangeLandingsRepo, {
      record: (landing) =>
        Effect.sync(() => {
          const row = toRow(landing);
          landings.unshift(row);
          return row;
        }),
      byId: (id) => Effect.succeed(landings.find((landing) => landing.id === id) ?? null),
      listForChange: () => Effect.sync(() => [...landings]),
      latestForChange: () => Effect.sync(() => landings[0] ?? null),
      claimTourDescription: (id, tourId) =>
        Effect.sync(() => {
          if (!landings.some((landing) => landing.id === id)) return false;
          if (describedTours.get(id) === tourId) return false;
          describedTours.set(id, tourId);
          return true;
        }),
      observePullRequest: (id, pullRequest: LandedPullRequest) =>
        Effect.sync(() => {
          const index = landings.findIndex((landing) => landing.id === id);
          const current = landings[index];
          if (current === undefined || current.pullRequest === null) return null;
          const updated = new ChangeLanding({ ...current, pullRequest });
          landings[index] = updated;
          return updated;
        }),
    }),
  );

  return { project, worktree, session, siblings, change, landings, repos };
};

export type World = ReturnType<typeof makeWorld>;

export const checkpointOf = (
  world: World,
  ordinal: number,
  sha: string,
  trigger: Checkpoint["trigger"],
): Checkpoint =>
  new Checkpoint({
    id: CheckpointId.make(`cp-${ordinal}`),
    worktreeId: world.worktree.id,
    sessionId: world.session.id,
    ordinal,
    ref: `refs/mend/checkpoints/${world.worktree.id}/${ordinal}`,
    sha: Sha.make(sha),
    sealantRunId: null,
    seq: 0n,
    trigger,
    createdAt: NOW,
  });
