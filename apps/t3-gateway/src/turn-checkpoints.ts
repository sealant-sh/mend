import type { MendCheckpoint, MendRangeFile, MendTurn } from "./mend-workbench.ts";
import { byOrdinal } from "./shell.ts";

/**
 * Which checkpoint is which turn's (ADR 0012, "Additive reads in Mend"; the gateway says so when
 * sessions share a worktree). Pure functions over the worktree's chain and the session's turns.
 *
 * - A turn's checkpoint is the one Mend took when it ended, which names the turn (SLNT-1263): one
 *   taken as a turn ends can land after the next turn began, so times can't say whose it is. A
 *   turn from a Mend that didn't name them takes the last `turn-boundary` checkpoint its session
 *   took between the turn's start and the next turn's, among those that name no turn.
 * - A turn starts from the newest checkpoint of the chain, any session's, taken before it began,
 *   or the turn before's own when that one landed later: the worktree as the turn found it. With
 *   none, it starts from the worktree's base.
 * - When another session has checkpoints in the chain, the worktree is shared, and a turn's slice
 *   may hold what that session changed while the turn ran; the thread says so.
 */

/** One turn's slice of the chain: where it started, and its own checkpoint. */
export interface TurnSlice {
  /** Null: the worktree's base. */
  readonly from: MendCheckpoint | null;
  readonly to: MendCheckpoint;
}

const millis = (iso: string | null | undefined): number => {
  const parsed = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const startOf = (turn: MendTurn): number => millis(turn.startedAt ?? turn.createdAt);

/** Turn id → its slice, for every ended turn whose checkpoint Mend took. */
export const turnSlicesOf = (
  sessionId: string,
  turns: ReadonlyArray<MendTurn>,
  chain: ReadonlyArray<MendCheckpoint>,
): ReadonlyMap<string, TurnSlice> => {
  const sorted = turns.toSorted(byOrdinal);
  const byTime = chain.toSorted((left, right) => left.ordinal - right.ordinal);
  const slices = new Map<string, TurnSlice>();
  sorted.forEach((turn, index) => {
    if (turn.endedAt === null) return;
    const start = startOf(turn);
    const next = sorted[index + 1];
    const end = next === undefined ? Number.POSITIVE_INFINITY : startOf(next);
    const to =
      byTime.findLast(
        (checkpoint) => checkpoint.turnId === turn.id && checkpoint.sessionId === sessionId,
      ) ??
      byTime.findLast(
        (checkpoint) =>
          checkpoint.sessionId === sessionId &&
          checkpoint.trigger === "turn-boundary" &&
          checkpoint.turnId === undefined &&
          millis(checkpoint.createdAt) >= start &&
          millis(checkpoint.createdAt) < end,
      );
    if (to === undefined) return;
    // The turn before's own checkpoint can land after this turn began: it is still where it started.
    const previous = sorted[index - 1];
    const from =
      byTime.findLast(
        (checkpoint) =>
          checkpoint.ordinal < to.ordinal &&
          (millis(checkpoint.createdAt) < start ||
            (previous !== undefined && checkpoint.turnId === previous.id)),
      ) ?? null;
    slices.set(turn.id, { from, to });
  });
  return slices;
};

/** Whether another session took checkpoints in the worktree: its slices may hold that work too. */
export const isSharedChain = (sessionId: string, chain: ReadonlyArray<MendCheckpoint>): boolean =>
  chain.some((checkpoint) => checkpoint.sessionId !== null && checkpoint.sessionId !== sessionId);

/** The cache key of one slice: both ends are immutable, so a slice never changes. */
export const sliceKey = (slice: TurnSlice): string => `${slice.from?.id ?? "base"}..${slice.to.id}`;

/** A file of a slice as t3code's checkpoint card lists it. */
export const checkpointFileOf = (
  file: MendRangeFile,
): {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
} => ({
  path: file.newPath ?? file.oldPath ?? "",
  kind:
    file.status === "added" || file.status === "deleted" || file.status === "renamed"
      ? file.status
      : "modified",
  additions: file.additions,
  deletions: file.deletions,
});

/** The words a thread shows when its worktree is shared with another session. */
export const SHARED_CHAIN_NOTICE =
  "Other sessions work in this worktree too: a turn's changes can include theirs from while it ran.";
