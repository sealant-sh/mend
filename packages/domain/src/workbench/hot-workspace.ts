import { Schema } from "effect";

import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "../ids.ts";
import { WorkspaceImage } from "../settings.ts";
import { Timestamp } from "../timestamp.ts";
import { SessionExtraMount } from "./mount.ts";
import { SessionReferenceMount } from "./reference.ts";
import { SessionDotfiles } from "./session.ts";

/**
 * Lifecycle of a hot workspace: `warming` while the workspace is being provisioned, `ready` once
 * it can be claimed, `claimed` between a session adopting it and its launch consuming it, and
 * `failed` when provisioning broke (the error rides beside it; the reconciler retries later).
 */
export const HotWorkspaceStatus = Schema.Literals(["warming", "ready", "claimed", "failed"]);
export type HotWorkspaceStatus = typeof HotWorkspaceStatus.Type;

/**
 * The environment manifest captured when the hot workspace was created — the exact revisions and
 * NAMES (never values) that launched, replayed onto the claiming session's run record.
 */
export const HotWorkspaceEnvironment = Schema.Struct({
  environmentRevision: Schema.Number,
  environmentVariableNames: Schema.Array(Schema.String),
  secretRevision: Schema.Number,
  secretNames: Schema.Array(Schema.String),
  // Cluster-binding manifest (cluster-env-sources): `kind/objectName` strings + the workspace
  // ServiceAccount, names only. Optional so entries provisioned before the feature still decode.
  clusterBindingRevision: Schema.optional(Schema.Number),
  clusterBindingNames: Schema.optional(Schema.Array(Schema.String)),
  clusterServiceAccount: Schema.optional(Schema.NullOr(Schema.String)),
});
export type HotWorkspaceEnvironment = typeof HotWorkspaceEnvironment.Type;

/**
 * A pre-provisioned session skeleton kept ready so a new session attaches instantly: a
 * pre-generated session id, the worktree and branch derived from it, and a live workspace
 * mounting that worktree. The platform fixes every create-time input (mount path, env, secrets,
 * dotfiles, image, credentials) at `workspaces.create`, so the skeleton is only claimable while
 * those inputs still match — `fingerprint` hashes them, and a mismatch drains the entry.
 *
 * `id` IS the session id: at claim the new session adopts it, because the worktree path and the
 * session socket directory are deterministic per session id and are already bound into the
 * running workspace.
 */
export class HotWorkspace extends Schema.Class<HotWorkspace>("HotWorkspace")({
  id: SessionId,
  projectId: ProjectId,
  /**
   * Null since standby workspaces (ADR-0001): a skeleton no longer pre-creates a worktree —
   * the pool mounts the project's worktrees root and the claiming session binds its own at
   * launch. Rows from before still carry the pre-created worktree the drain must remove.
   */
  worktreeId: Schema.NullOr(WorktreeId),
  /**
   * The account the workspace was provisioned as: its connected accounts, dotfiles and signer.
   * Only that account's sessions claim it (docs/adr/0003-organizations-and-tenancy.md).
   */
  ownerUserId: Schema.String,
  status: HotWorkspaceStatus,
  /** Why provisioning failed, when it did — surfaced on the project setup page. */
  error: Schema.NullOr(Schema.String),
  /** Hash of every create-time-fixed input; claims require an exact match. */
  fingerprint: Schema.String,
  /** Worktree directory name inside the project's store (derived from `id`). */
  worktree: Schema.NullOr(Schema.String),
  /** The pre-created session branch the worktree is on. */
  branch: Schema.NullOr(Schema.String),
  /** Where the worktree branched from at prewarm; the claim resets it to the requested base. */
  baseSha: Schema.NullOr(Sha),
  /** The live workspace, once created. Null while warming. */
  sealantWorkspaceId: Schema.NullOr(SealantWorkspaceId),
  /** The image the workspace actually launched with — stamped onto the claiming session. */
  workspaceImage: Schema.NullOr(WorkspaceImage),
  /** The dotfiles the workspace actually launched with — stamped onto the claiming session. */
  dotfiles: Schema.NullOr(SessionDotfiles),
  /** The env manifest the workspace actually launched with — stamped onto the session run. */
  environment: Schema.NullOr(HotWorkspaceEnvironment),
  /** References mounted read-only beside the worktree, SHAs as observed at prewarm. */
  referenceMounts: Schema.Array(SessionReferenceMount),
  /** Project folders mounted beside the worktree at prewarm. */
  extraMounts: Schema.Array(SessionExtraMount),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}
