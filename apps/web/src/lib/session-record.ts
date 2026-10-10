/**
 * What a settled session with no platform run says about its record. Every launch is supervised, so
 * a missing run means none started: a launch that failed before the workspace was ready, a session
 * stopped while it was still starting, or one from before the supervised path. Recording was never
 * turned off, and the words say which of those it was rather than "off".
 */
export interface NoRunWords {
  /** The line under the session's summary. */
  readonly note: string;
  /** The Record card's header. */
  readonly header: string;
}

export const noRunWords = (status: string): NoRunWords =>
  status === "failed"
    ? {
        note: "no record — the launch failed before the session's run started (the error is above); worktree, checkpoints, and review are live",
        header: "no record — the launch failed before a run started",
      }
    : {
        note: "no record — no run started for this session; worktree, checkpoints, and review are live",
        header: "no record — no run started for this session",
      };
