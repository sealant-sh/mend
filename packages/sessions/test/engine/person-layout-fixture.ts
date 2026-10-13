import type { HarnessLayoutsMemoryState } from "@mend/db";

/**
 * A person worktree that existed before this Mend started: the startup query sees a layout
 * recorded, as it would in the database (a test seeds the worktree under test only once it is
 * made, after the engine is up).
 */
export const recordedBeforeStart = (
  state: HarnessLayoutsMemoryState,
): HarnessLayoutsMemoryState => {
  state.worktrees.set("wt-person-before-start", { layout: "person", requested: null });
  return state;
};
