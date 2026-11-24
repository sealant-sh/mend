import type { SessionId } from "@mend/domain";
import { Effect } from "effect";
import * as Context from "effect/Context";

/**
 * How far Mend's Git signer goes for a worktree (agent-home `workspace-isolation-architecture.md`
 * §7.4, ADR 0025's 2026-11-24 amendment): `disabled` signs nothing, `read-only` signs fetches and
 * archives, `read-write` signs those and pushes to the project's own repository. A cap on the
 * signer only: the person's Account Git access mode still chooses how they sign.
 */
export type GitTransportCeiling = "disabled" | "read-only" | "read-write";

/** The rules of a worktree's Access policy that Mend enforces in its own process. */
export interface WorktreeAccessPolicy {
  readonly gitTransport: GitTransportCeiling;
  /** Whether the session's agents may call the organization's Executor tools (ADR 0022). */
  readonly allowExecutorTools: boolean;
}

/** `Standard`: what every worktree has until an Access policy says otherwise. */
export const STANDARD_ACCESS_POLICY: WorktreeAccessPolicy = {
  gitTransport: "read-write",
  allowExecutorTools: true,
};

/** Where a session's worktree policy is read from. */
export interface AccessPolicySource {
  readonly forSession: (sessionId: SessionId) => Effect.Effect<WorktreeAccessPolicy>;
}

/**
 * The one place Mend's enforcement points read a session's worktree policy: the Git signer and
 * the MCP dispatcher's Executor tools. Until Access policies are stored, every session reads
 * `STANDARD_ACCESS_POLICY`; providing this reference is how stored policies reach both, with
 * neither enforcement point changed.
 */
export const AccessPolicies: Context.Reference<AccessPolicySource> =
  Context.Reference<AccessPolicySource>("@mend/sessions/AccessPolicies", {
    defaultValue: () => ({ forSession: () => Effect.succeed(STANDARD_ACCESS_POLICY) }),
  });
