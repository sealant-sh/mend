import { createSession, createSessionInWorktree, launchSessionStart } from "./api.ts";

/**
 * The sessions a project's page starts without a first message: a shell, a session in an
 * existing worktree, and a setup session. Each says how its session is made and how its agent
 * starts, for an instant start (`components/new-session/instant-start.ts`): the session's page
 * opens at once, and a launch that fails is that page's to show (the session records it).
 */
export interface ProjectStart {
  readonly harness: string;
  readonly make: () => Promise<string>;
  readonly launch: (sessionId: string) => Promise<unknown>;
}

const launchOf =
  (agent: string) =>
  (sessionId: string): Promise<unknown> =>
    launchSessionStart(sessionId, agent, {});

/** Where a shell starts: in a worktree's workspace, beside its sessions, or in a new worktree. */
export type ShellTarget =
  | { readonly _tag: "worktree"; readonly worktreeId: string }
  | { readonly _tag: "new"; readonly projectId: string };

export const shellStart = (target: ShellTarget): ProjectStart => ({
  harness: "shell",
  make: async () =>
    (target._tag === "worktree"
      ? await createSessionInWorktree(target.worktreeId, "shell")
      : await createSession(target.projectId, "shell")
    ).id,
  launch: launchOf("shell"),
});

/** Another session in a worktree that already exists; it follows the project on landing. */
export const worktreeStart = (worktreeId: string, agent: string): ProjectStart => ({
  harness: agent,
  make: async () => (await createSessionInWorktree(worktreeId, agent)).id,
  launch: launchOf(agent),
});

/**
 * A setup session (`purpose: "setup"`) in a new worktree: Mend gives the agent its opening
 * message, to study the repository and propose `.mend/` files. It never lands on its own.
 */
export const setupStart = (projectId: string, agent: string): ProjectStart => ({
  harness: agent,
  make: async () => (await createSession(projectId, agent, null, null, false, "setup")).id,
  launch: launchOf(agent),
});
