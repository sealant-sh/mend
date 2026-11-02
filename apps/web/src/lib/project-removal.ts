import { failureWords, removalRefusalDataOf } from "#/lib/refusal";

/** A project removal that did not go ahead, as the Configuration page shows it. */
export interface ProjectRemovalFailure {
  /** Mend's words, verbatim, or the failure's own. */
  readonly words: string;
  /** The worktrees that stand in the way, each named once, when Mend refused. */
  readonly worktrees: ReadonlyArray<string>;
}

/**
 * Why a project removal did not go ahead. A refusal (`RemovalRefused`) names every worktree that
 * stands in the way, anyone's; anything else is shown in its own words. Nothing was removed or
 * stopped either way.
 */
export const projectRemovalFailureOf = (cause: unknown): ProjectRemovalFailure => {
  const words = failureWords(cause, "The project was not removed. Try again.");
  const refusal = removalRefusalDataOf(cause);
  if (refusal === null || refusal.scope !== "project") return { words, worktrees: [] };
  const named = refusal.blockers.flatMap((blocker) =>
    "worktreeName" in blocker ? [blocker.worktreeName] : [],
  );
  return { words, worktrees: [...new Set(named)] };
};
