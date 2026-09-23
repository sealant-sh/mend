import type { EffortLevel, PermissionMode, SpeedMode } from "@mend/domain/workbench";
import type { QueryClient } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";

import {
  createSession,
  createSessionInWorktree,
  launchSessionStart,
  type SessionDto,
  type WorktreeDto,
} from "#/lib/api";
import type { TrpcProxy } from "#/lib/trpc";

/** Harnesses the web can start; opencode stays CLI-only until it is exercised end to end. */
export const HARNESSES = ["claude", "codex", "shell"] as const;
export type Harness = (typeof HARNESSES)[number];

type Navigate = UseNavigateResult<string>;

/** The first message and harness options, independent of where the session runs. */
export interface SessionStartSpec {
  readonly harness: Harness;
  /** Empty starts the harness without an initial message. */
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permissionMode?: PermissionMode;
  readonly speed?: SpeedMode;
  /**
   * The session's own "Land when a turn completes" (docs/adr/0007-landing.md); null or absent
   * follows the project.
   */
  readonly autoLand?: boolean | null;
}

/** A project quick-start also provisions a worktree. The composer uses an existing worktree. */
export interface LaunchSpec extends SessionStartSpec {
  /** Branch or sha for the new worktree; null uses the project's default branch. */
  readonly base?: string | null;
  /** Null derives a worktree name from its generated identity. */
  readonly name?: string | null;
}

/** Router and query-cache capabilities supplied by the calling component. */
export interface LaunchContext {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
}

/** Start the supervised process without holding navigation until it finishes provisioning. */
const launchCreatedSession = (
  navigate: Navigate,
  { queryClient, trpc }: LaunchContext,
  session: SessionDto,
  spec: SessionStartSpec,
): Promise<void> => {
  const prompt = spec.prompt.trim();
  // Launch failures settle the durable session; its page shows the recorded failure.
  void launchSessionStart(session.id, {
    ...(prompt === "" ? {} : { prompt }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    ...(spec.permissionMode === undefined ? {} : { permissionMode: spec.permissionMode }),
    ...(spec.speed === undefined ? {} : { speed: spec.speed }),
  })
    .catch(() => undefined)
    .finally(() => {
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      void queryClient.invalidateQueries(trpc.projects.pathFilter());
      void queryClient.invalidateQueries(trpc.worktrees.pathFilter());
    });
  return navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
};

/** Project quick-start: provision a worktree and session, launch, then open the session. */
export const startComposedSession = (
  navigate: Navigate,
  context: LaunchContext,
  projectId: string,
  spec: LaunchSpec,
): Promise<void> =>
  createSession(
    projectId,
    spec.harness,
    spec.base ?? null,
    spec.name ?? null,
    spec.autoLand ?? null,
  ).then((session) => launchCreatedSession(navigate, context, session, spec));

/** Start inside the explicitly selected worktree. This operation never creates a worktree. */
export const startComposedSessionInWorktree = (
  navigate: Navigate,
  context: LaunchContext,
  worktreeId: WorktreeDto["id"],
  spec: SessionStartSpec,
): Promise<void> =>
  createSessionInWorktree(worktreeId, spec.harness, spec.autoLand ?? null).then((session) =>
    launchCreatedSession(navigate, context, session, spec),
  );
