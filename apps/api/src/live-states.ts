import type { SessionStatus } from "@mend/domain/workbench";

/** A session in one of these is live: it holds its worktree, and removal is refused for it. */
export const LIVE_STATES: ReadonlySet<SessionStatus> = new Set([
  "starting",
  "running",
  "waiting",
  "idle",
]);
