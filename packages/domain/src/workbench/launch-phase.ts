/**
 * What a launch says on the session line while it is under way and before its agent runs: it waits
 * for the worktree's previous executor to end, or the platform readies the workspace. Always the
 * last words of the summary, replaced as the launch moves on and taken off once the agent runs; a
 * failure's own words replace them. Every surface reads the phase back from those words
 * (`launchPhaseOf`), so the server and the clients share them here.
 */
export const LAUNCH_WAITING_PREFIX = "waiting · the previous session in this worktree";
export const LAUNCH_WAITING_SAVING = `${LAUNCH_WAITING_PREFIX} is saving`;
/**
 * What a lookup of a live lease holder's workspace observed when it did not find a live one: the
 * platform's answer to the lookup (`failed`, with its status), or the state it reported
 * (`not-live`). Absent: Mend could not name the holder's workspace to look up.
 */
export type HolderLookupObserved =
  | { readonly kind: "failed"; readonly status: number | null; readonly code: string }
  | { readonly kind: "not-live"; readonly state: string };

/**
 * The session line while a launch waits on the worktree's previous executor, by how it stands. A
 * holder whose lease is live but whose workspace the platform did not find says exactly that, never
 * "not answering": the heartbeat says it answers (alpha 2026-10-06, 9e486cfc).
 */
export const leaseWaitWords = (holder: {
  readonly kind: "ending" | "unreachable" | "lapsed";
  readonly lookup?: HolderLookupObserved | null;
}): string => {
  if (holder.kind === "ending") return LAUNCH_WAITING_SAVING;
  if (holder.kind === "lapsed") return `${LAUNCH_WAITING_PREFIX} has not confirmed its end`;
  const lookup = holder.lookup ?? null;
  if (lookup?.kind === "failed" && lookup.status === 404) {
    return `${LAUNCH_WAITING_PREFIX} renews its lease, but the platform did not find its workspace (404)`;
  }
  if (lookup?.kind === "not-live") {
    return `${LAUNCH_WAITING_PREFIX} renews its lease, but the platform reports its workspace ${lookup.state}`;
  }
  return `${LAUNCH_WAITING_PREFIX} is not answering`;
};
export const LAUNCH_BOOTING = "booting";
/**
 * No executor yet, a while into the create. The platform reports no image build (SDK 0.38), so
 * this says what was observed and what it usually means, never that an image is being built.
 */
export const LAUNCH_PREPARING =
  "preparing the workspace · no runtime yet · after an update, building the image takes about 8 minutes";
/** What `LAUNCH_PREPARING` said before 2026-10-02, still in stored summaries. */
const LAUNCH_BUILDING_IMAGE_LEGACY =
  "building the workspace image (first launch after an update, ~8 min)";
const LAUNCH_PHASE_PREFIXES = [
  LAUNCH_WAITING_PREFIX,
  LAUNCH_BOOTING,
  LAUNCH_PREPARING,
  LAUNCH_BUILDING_IMAGE_LEGACY,
];

/** The phase words at the end of a summary, and where they begin; null when it has none. */
const phaseWordsOf = (summary: string): { readonly at: number; readonly words: string } | null => {
  for (const prefix of LAUNCH_PHASE_PREFIXES) {
    if (summary.startsWith(prefix)) return { at: 0, words: summary };
    const at = summary.indexOf(` · ${prefix}`);
    if (at >= 0) return { at, words: summary.slice(at + 3) };
  }
  return null;
};

/** A summary without the launch phase words at its end; null when they were all it said. */
export const withoutLaunchPhase = (summary: string | null): string | null => {
  if (summary === null) return null;
  const phase = phaseWordsOf(summary);
  if (phase === null) return summary;
  return phase.at === 0 ? null : summary.slice(0, phase.at);
};

export type LaunchPhase =
  /** The worktree's previous executor has not ended (saving, not answering, not confirmed). */
  | { readonly kind: "waiting-previous"; readonly words: string }
  | { readonly kind: "booting"; readonly words: string }
  /** No runtime yet: the platform may be building the workspace image. */
  | { readonly kind: "preparing"; readonly words: string };

/** The launch phase a starting session's summary names; null when it names none. */
export const launchPhaseOf = (summary: string | null): LaunchPhase | null => {
  if (summary === null) return null;
  const phase = phaseWordsOf(summary);
  if (phase === null) return null;
  if (phase.words.startsWith(LAUNCH_WAITING_PREFIX)) {
    return { kind: "waiting-previous", words: phase.words };
  }
  if (phase.words.startsWith(LAUNCH_BOOTING)) return { kind: "booting", words: phase.words };
  return { kind: "preparing", words: phase.words };
};
