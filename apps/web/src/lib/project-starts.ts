import { createSession, createSessionInWorktree, launchSessionStart } from "./api.ts";

/**
 * The sessions a project's page starts without a first message: a shell, a session in an
 * existing worktree, and a setup session. Each answers the session's id once it exists; its agent
 * keeps starting after that, and a launch that fails is the session page's to show (the session
 * records it), so it is not awaited. A failure to make the session is the caller's to show.
 */

const launch = (sessionId: string, agent: string): string => {
  void launchSessionStart(sessionId, agent, {}).catch(() => undefined);
  return sessionId;
};

/** Where a shell starts: in a worktree's workspace, beside its sessions, or in a new worktree. */
export type ShellTarget =
  | { readonly _tag: "worktree"; readonly worktreeId: string }
  | { readonly _tag: "new"; readonly projectId: string };

export const startShell = async (target: ShellTarget): Promise<string> => {
  const session =
    target._tag === "worktree"
      ? await createSessionInWorktree(target.worktreeId, "shell")
      : await createSession(target.projectId, "shell");
  return launch(session.id, "shell");
};

/** Another session in a worktree that already exists; it follows the project on landing. */
export const startInWorktree = async (worktreeId: string, agent: string): Promise<string> => {
  const session = await createSessionInWorktree(worktreeId, agent);
  return launch(session.id, agent);
};

/**
 * A setup session (`purpose: "setup"`) in a new worktree: Mend gives the agent its opening
 * message, to study the repository and propose `.mend/` files. It never lands on its own.
 */
export const startSetupSession = async (projectId: string, agent: string): Promise<string> => {
  const session = await createSession(projectId, agent, null, null, false, "setup");
  return launch(session.id, agent);
};
