import { Schema } from "effect";

import { ProjectId, SessionId, SessionRepositoryId, Sha, WorktreeId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A repository in a session (docs/adr/0011-repositories-in-a-session.md): another project of the
 * store, present in the session's workspace at `/workspace/repos/<name>` as a worktree of that
 * project, on a branch of its own for this session. The worktree is the durable container, so the
 * repository owns its change, its checkpoints and its landing exactly as the main worktree does;
 * this row is the session's list of what it holds, and the join the review uses to find the
 * session behind a sibling worktree.
 */

/** A directory name under `/workspace/repos/`: the same shape as a store name. */
export const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const isRepositoryName = (name: string): boolean => REPOSITORY_NAME.test(name);

/** Where the agent and the person work in it. */
export const repositoryPath = (name: string): string => `/workspace/repos/${name}`;

/**
 * Where its files live while sealantd captures one root (ADR 0011 "How it is saved", today): a
 * nested repository inside the main worktree, carried by the main worktree's captures and restored
 * with them. `repositoryPath` is a symlink to it, recreated at every launch.
 */
export const nestedRepositoryPath = (name: string): string => `/workspace/repo/.mend/repos/${name}`;

/** The line that keeps the nested directory out of the main repository's `git status`. */
export const NESTED_REPOSITORIES_EXCLUDE = ".mend/";

/**
 * `adding` while Mend brings the files in; `ready` once they are there; `failed` with the reason
 * when they could not be brought in; `missing` when a repository that was ready did not come back
 * with a restored workspace.
 */
export const SessionRepositoryState = Schema.Literals(["adding", "ready", "failed", "missing"]);
export type SessionRepositoryState = typeof SessionRepositoryState.Type;

/**
 * How the repository is saved: `nested` inside the main worktree's captures (today), `own` under
 * its own capture chain once sealantd carries repository roots.
 */
export const SessionRepositoryCapture = Schema.Literals(["nested", "own"]);
export type SessionRepositoryCapture = typeof SessionRepositoryCapture.Type;

/** Where its files came from: a clone of the project's origin, or Mend's store. */
export const SessionRepositorySource = Schema.Literals(["origin", "store"]);
export type SessionRepositorySource = typeof SessionRepositorySource.Type;

export class SessionRepository extends Schema.Class<SessionRepository>("SessionRepository")({
  id: SessionRepositoryId,
  sessionId: SessionId,
  /** The repository's project, never the session's own. */
  projectId: ProjectId,
  /** The worktree of that project this session works in. */
  worktreeId: WorktreeId,
  /** The directory name under `/workspace/repos/`. */
  name: Schema.String,
  /** `repositoryPath(name)`, recorded so the record reads without computing. */
  path: Schema.String,
  /** Mirrors of the worktree row, as the session's own `branch` and `baseSha` are. */
  branch: Schema.String,
  baseSha: Sha,
  baseRef: Schema.NullOr(Schema.String),
  state: SessionRepositoryState,
  /** Why it `failed` or went `missing`, in the words the person reads. */
  error: Schema.NullOr(Schema.String),
  capture: SessionRepositoryCapture,
  source: SessionRepositorySource,
  /** The account that asked for it: the session's owner. */
  addedByUserId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  readyAt: Schema.NullOr(Timestamp),
}) {}

/** How the repository is saved, as a fact beside the path. */
export const repositorySavedWords = (repository: {
  readonly capture: SessionRepositoryCapture;
}): string =>
  repository.capture === "nested"
    ? "saved with the main repository"
    : "saved under its own captures";
