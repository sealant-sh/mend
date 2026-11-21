import { startSessionNow, type StartTarget } from "./api.ts";

/**
 * The sessions a project's page starts without a first message: a shell, a session in an
 * existing worktree, and a setup session. Each says how its session is made and launched, in one
 * request (SLNT-1239), for an instant start (`components/new-session/instant-start.ts`): the
 * session's page opens at once, and a launch that fails is that page's to show (the session
 * records it).
 */
export interface ProjectStart {
  readonly harness: string;
  readonly start: (key: string) => Promise<string>;
}

const startOf =
  (target: StartTarget, harness: string) =>
  async (key: string): Promise<string> =>
    (await startSessionNow(key, target, harness, {})).id;

/** Where a shell starts: in a worktree's workspace, beside its sessions, or in a new worktree. */
export type ShellTarget =
  | { readonly _tag: "worktree"; readonly worktreeId: string }
  | { readonly _tag: "new"; readonly projectId: string };

export const shellStart = (target: ShellTarget): ProjectStart => ({
  harness: "shell",
  start: startOf(
    target._tag === "worktree"
      ? { _tag: "worktree", worktreeId: target.worktreeId, autoLand: null }
      : { _tag: "project", projectId: target.projectId, autoLand: null },
    "shell",
  ),
});

/** Another session in a worktree that already exists; it follows the project on landing. */
export const worktreeStart = (worktreeId: string, agent: string): ProjectStart => ({
  harness: agent,
  start: startOf({ _tag: "worktree", worktreeId, autoLand: null }, agent),
});

/**
 * A setup session (`purpose: "setup"`) in a new worktree: Mend gives the agent its opening
 * message, to study the repository and propose `.mend/` files. It never lands on its own.
 */
export const setupStart = (projectId: string, agent: string): ProjectStart => ({
  harness: agent,
  start: startOf({ _tag: "project", projectId, autoLand: false, purpose: "setup" }, agent),
});
