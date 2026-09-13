import { ProjectNotFoundError, ProjectsRepo } from "@mend/db";
import type { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { Store, worktreePathOf, type CheckpointSnapshot, type GitError } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * The session workspace AUTHORITY, keyed by identity — the deployment-strategy port
 * (docs/KUBERNETES.md grew the first two strategies; a hosted strategy is the third).
 *
 * The product invariant this port states is NOT an implementation technique: every WORKTREE has
 * exactly one authoritative mutable place, and file mutations, checkpoints, diffs and review
 * evidence are ordered against that authority — Mend never reviews a stale copy. Sessions are
 * conversations against it (several may be live at once); their workspaces all mount the same
 * authority. Today the
 * authority is a linked git worktree on this machine's store (`local`) or on the shared RWX claim
 * (`kubernetes`); both are co-located, and both are served by the LOCAL adapter below, which
 * resolves identities to store paths and runs git beside the files. A hosted strategy implements
 * the same operations by running git wherever the authority actually lives (e.g. inside the
 * workspace, over the session channel). Callers above this port name projects, sessions and
 * worktrees — never absolute paths.
 *
 * Co-location itself is a CAPABILITY, not an assumption: `worktreeMount` answers with the host
 * path only where this deployment mounts the authority into reach (Docker bind mounts, the
 * Kubernetes claim's subPaths). A hosted adapter answers `undefined`, and a caller that needs the
 * mount (workspace launches today) must degrade or refuse explicitly, never guess a path.
 */
export interface SessionWorktreeSummary {
  /** Directory name inside the project store's `worktrees/`; persisted on the session row. */
  readonly name: string;
  readonly branch: string;
  readonly baseSha: Sha;
  /** The base as resolved — the caller's ref, or the default branch when none was given. */
  readonly baseRef: string;
}

export type SessionRepositoryError = GitError | ProjectNotFoundError;

export class SessionRepository extends Context.Service<
  SessionRepository,
  {
    /**
     * Create a worktree on its own branch from `base` (default branch when null). The caller
     * owns identity (directory + branch). `remoteEnv` freshens the base from origin first
     * (best-effort); null skips the fetch.
     */
    readonly createWorktree: (
      projectId: ProjectId,
      identity: { readonly directory: string; readonly branch: string },
      base: string | null,
      remoteEnv: Record<string, string> | null,
    ) => Effect.Effect<SessionWorktreeSummary, SessionRepositoryError>;
    /**
     * Capture mode only (ADR-0002): once the worktree ROW exists, bind the authority's own
     * bookkeeping to it — capture 0 from the base, the lease and chain rows. Absent on the
     * co-located adapter, whose `createWorktree` already made the directory the authority.
     */
    readonly attachWorktree?: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<void, SessionRepositoryError>;
    /** Rename the branch a worktree is on in place; the directory never moves. */
    readonly renameBranch: (
      projectId: ProjectId,
      worktreeName: string,
      newBranch: string,
    ) => Effect.Effect<void, SessionRepositoryError>;
    /** Freshen an existing worktree to `base` without recreating it (hot-pool claims). */
    readonly resetWorktree: (
      projectId: ProjectId,
      worktreeName: string,
      base: string | null,
      remoteEnv: Record<string, string> | null,
    ) => Effect.Effect<{ readonly baseSha: Sha; readonly baseRef: string }, SessionRepositoryError>;
    /** Best-effort removal; a surviving path is reported, never thrown. */
    readonly removeWorktreeForce: (
      projectId: ProjectId,
      worktreeName: string,
    ) => Effect.Effect<{ readonly leftover: string | null }, ProjectNotFoundError>;
    /** Snapshot the authority without touching HEAD, index, or files. */
    readonly checkpoint: (input: {
      readonly projectId: ProjectId;
      /** The chain's ref namespace — the worktree id. */
      readonly scope: string;
      readonly worktreeName: string;
      readonly index: number;
      readonly parent: Sha | null;
    }) => Effect.Effect<CheckpointSnapshot, SessionRepositoryError>;
    /**
     * The authority's host path where this deployment co-locates Mend with the files;
     * `undefined` where it does not. Callers must treat absence as a capability gap, not an
     * error in itself.
     */
    readonly worktreeMount: (
      projectId: ProjectId,
      worktreeName: string,
    ) => Effect.Effect<string | undefined, ProjectNotFoundError>;
  }
>()("@mend/sessions/SessionRepository") {}

/**
 * The co-located adapter: identities resolve to store paths through `ProjectsRepo`, and git runs
 * beside the files via `Store`. Serves both the `local` and `kubernetes` deployment strategies —
 * on Kubernetes the "host path" is the claim mount, which IS this process's filesystem.
 */
export const SessionRepositoryLocalLive: Layer.Layer<
  SessionRepository,
  never,
  Store | ProjectsRepo
> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const store = yield* Store;
    const projects = yield* ProjectsRepo;

    return {
      createWorktree: (projectId, identity, base, remoteEnv) =>
        projects.byId(projectId).pipe(
          Effect.flatMap((project) =>
            store.createWorktree(project.storePath, identity, base, remoteEnv),
          ),
          Effect.map(({ name, branch, baseSha, baseRef }) => ({ name, branch, baseSha, baseRef })),
        ),
      renameBranch: (projectId, worktreeName, newBranch) =>
        projects
          .byId(projectId)
          .pipe(
            Effect.flatMap((project) =>
              store.renameBranch(worktreePathOf(project.storePath, worktreeName), newBranch),
            ),
          ),
      resetWorktree: (projectId, worktreeName, base, remoteEnv) =>
        projects.byId(projectId).pipe(
          Effect.flatMap((project) =>
            store.resetWorktree(project.storePath, worktreeName, base, remoteEnv),
          ),
          Effect.map(({ baseSha, baseRef }) => ({ baseSha, baseRef })),
        ),
      removeWorktreeForce: (projectId, worktreeName) =>
        projects
          .byId(projectId)
          .pipe(
            Effect.flatMap((project) => store.removeWorktreeForce(project.storePath, worktreeName)),
          ),
      checkpoint: (input) =>
        projects
          .byId(input.projectId)
          .pipe(
            Effect.flatMap((project) =>
              store.checkpoint(
                worktreePathOf(project.storePath, input.worktreeName),
                input.scope,
                input.index,
                input.parent,
              ),
            ),
          ),
      worktreeMount: (projectId, worktreeName) =>
        projects
          .byId(projectId)
          .pipe(Effect.map((project) => worktreePathOf(project.storePath, worktreeName))),
    };
  }),
);
