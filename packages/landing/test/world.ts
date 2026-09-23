import {
  ChangeLandingsRepo,
  ChangeToursRepo,
  type NewChangeLanding,
  ProjectsRepo,
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
  SessionId,
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
  const change = new Change({
    id: changeId,
    projectId,
    worktreeId,
    sessionId,
    branch,
    baseSha,
    headSha: null,
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
      pushedSha: result.outcome === "refused" ? null : result.pushedSha,
      trigger: landing.trigger,
      pullRequest: result.outcome === "pull-request" ? result.pullRequest : null,
      outcome: result.outcome,
      message: result.outcome === "refused" || result.outcome === "failed" ? result.message : null,
      userId: landing.userId,
      createdAt: new Date(NOW.getTime() + landings.length * 1000),
    });
  };

  const repos = Layer.mergeAll(
    Layer.mock(SessionsRepo, { byId: () => Effect.succeed(session) }),
    Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
    Layer.mock(WorktreesRepo, { byId: () => Effect.succeed(worktree) }),
    Layer.mock(WorktreeChangesRepo, { byWorktree: () => Effect.succeed(change) }),
    Layer.mock(ChangeToursRepo, { byChange: () => Effect.succeed(tour) }),
    Layer.mock(UsersRepo, { byId: (id) => Effect.succeed(users.get(id) ?? null) }),
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

  return { project, worktree, session, change, landings, repos };
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
