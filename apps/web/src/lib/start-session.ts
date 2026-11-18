import type { SessionDto } from "./api.ts";
import { launchFields, type StartSpec, type WorktreeTarget } from "./new-session.ts";

/** The server calls a start makes; the browser's are in `api.ts`. */
export interface StartCalls {
  /** A new worktree from the project's default branch, with the session in it. */
  readonly create: (
    projectId: string,
    agent: string,
    autoLand: boolean | null,
  ) => Promise<Pick<SessionDto, "id">>;
  /** A new session in an existing worktree. */
  readonly createInWorktree: (
    worktreeId: string,
    agent: string,
    autoLand: boolean | null,
  ) => Promise<Pick<SessionDto, "id">>;
  readonly launch: (
    sessionId: string,
    agent: string,
    fields: ReturnType<typeof launchFields>,
  ) => Promise<unknown>;
}

/**
 * Start a session: make it, in a new worktree or the one picked, then start its agent on the
 * first message. Answers the session's id once it exists; the agent keeps starting after that, and
 * a launch that fails is the session page's to show (the session records it), so it is not
 * awaited here. A failure to make the session is the caller's to show.
 */
export const startSession = async (
  calls: StartCalls,
  projectId: string,
  target: WorktreeTarget,
  spec: StartSpec,
): Promise<string> => {
  const session =
    target._tag === "new"
      ? await calls.create(projectId, spec.agent, spec.autoLand)
      : await calls.createInWorktree(target.id, spec.agent, spec.autoLand);
  void calls.launch(session.id, spec.agent, launchFields(spec)).catch(() => undefined);
  return session.id;
};
