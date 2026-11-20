import { type AgentTurnDto, isOpenTurn } from "@mend/agent-conversation";

import { countWords } from "./review-comments.ts";

/**
 * What the conversation shows of checkpoints (SLNT-1200). Mend takes a checkpoint, a saved copy of
 * the worktree's files on a hidden ref, when a session starts, when each turn ends, when someone
 * opens a review or marks one by hand, and at a few other moments. A single prompt can take three.
 * The Record lists every one; the conversation shows at most one per turn, after it, and only when
 * a file changed during the turn. Its number is left off the line because the conversation hides
 * some of the chain: the first one a person sees could read "Checkpoint 3". The number stays in the
 * line's details, where it matches the Record, the Change tab's range and a landing.
 */

/** A checkpoint of the worktree's chain, as the conversation reads it. */
export interface ChainCheckpoint {
  readonly id: string;
  readonly ordinal: number;
  /** Null for the worktree's own: its starting checkpoint, or a review opened with no session. */
  readonly sessionId: string | null;
  readonly sha: string;
  readonly createdAt: Date | string;
}

/** A turn as its checkpoint is found: its place, whether it ended, and when it began. */
export interface TurnTimes extends AgentTurnDto {
  readonly startedAt: string | null;
}

/** One ended turn's checkpoint, and the one the worktree stood at when the turn began. */
export interface TurnCheckpoint {
  readonly turnId: string;
  /** The last checkpoint this session took from the turn's start until the next turn's. */
  readonly to: ChainCheckpoint;
  /** The newest checkpoint of the chain, any session's, taken before the turn began. */
  readonly from: ChainCheckpoint | null;
}

const millis = (at: Date | string): number => new Date(at).getTime();

/**
 * Each ended turn's checkpoint: the last one this session took between the turn's start and the
 * next turn's (Mend takes one when a turn ends; one taken after it, by a review or by hand, before
 * the next message is the same turn's). It starts from the newest checkpoint of the whole chain
 * taken before the turn began. A turn still running, or one Mend took no checkpoint for, has none.
 * The same rule as the t3code gateway's `turnSlicesOf`.
 */
export const turnCheckpoints = (
  turns: ReadonlyArray<TurnTimes>,
  chain: ReadonlyArray<ChainCheckpoint>,
  sessionId: string,
): ReadonlyArray<TurnCheckpoint> => {
  const sorted = turns.toSorted((a, b) => a.ordinal - b.ordinal);
  const byOrdinal = chain.toSorted((a, b) => a.ordinal - b.ordinal);
  const startOf = (turn: TurnTimes) => millis(turn.startedAt ?? turn.createdAt);
  return sorted.flatMap((turn, index): ReadonlyArray<TurnCheckpoint> => {
    if (isOpenTurn(turn)) return [];
    const start = startOf(turn);
    const next = sorted[index + 1];
    const end = next === undefined ? Number.POSITIVE_INFINITY : startOf(next);
    const to = byOrdinal.findLast(
      (checkpoint) =>
        checkpoint.ordinal > 0 &&
        checkpoint.sessionId === sessionId &&
        millis(checkpoint.createdAt) >= start &&
        millis(checkpoint.createdAt) < end,
    );
    if (to === undefined) return [];
    const from =
      byOrdinal.findLast(
        (checkpoint) => checkpoint.ordinal < to.ordinal && millis(checkpoint.createdAt) < start,
      ) ?? null;
    return [{ turnId: turn.id, to, from }];
  });
};

/** Which files changed in a turn: how many, whether there are more than Mend listed, the first few. */
export interface SliceFiles {
  readonly count: number;
  readonly more: boolean;
  readonly paths: ReadonlyArray<string>;
}

/** A turn's checkpoint as the conversation draws it, after the turn's reply. */
export interface CheckpointMark {
  readonly key: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly sha: string;
  readonly at: string;
  /** Where the turn started, for its changes in the Change tab; null: the worktree's base. */
  readonly fromId: string | null;
  readonly toId: string;
  /** Null when Mend couldn't say which files changed: the line shows, without a count. */
  readonly files: SliceFiles | null;
}

/** What the conversation knows of one turn's files: still asking, couldn't tell, or the answer. */
export interface SliceAnswer {
  readonly status: "pending" | "error" | "success";
  readonly data: SliceFiles | undefined;
}

/**
 * The turns' checkpoints the conversation draws: those where a file changed during the turn. One
 * whose files are still being read waits, so a line never shows and then goes. One Mend couldn't
 * read shows: there is a checkpoint and nobody can say it is empty.
 */
export const checkpointMarks = (
  turns: ReadonlyArray<TurnCheckpoint>,
  answers: ReadonlyArray<SliceAnswer>,
): ReadonlyArray<CheckpointMark> =>
  turns.flatMap((turn, index): ReadonlyArray<CheckpointMark> => {
    const answer = answers[index];
    if (answer === undefined || answer.status === "pending") return [];
    const files = answer.status === "success" ? (answer.data ?? null) : null;
    if (files !== null && files.count === 0 && !files.more) return [];
    return [
      {
        key: `checkpoint:${turn.to.ordinal}`,
        turnId: turn.turnId,
        ordinal: turn.to.ordinal,
        sha: turn.to.sha.slice(0, 7),
        at: new Date(turn.to.createdAt).toISOString(),
        fromId: turn.from?.id ?? null,
        toId: turn.to.id,
        files,
      },
    ];
  });

/** Whether the line knows how many files changed. */
const counted = (files: SliceFiles | null): files is SliceFiles =>
  files !== null && files.count > 0;

/** "3 files changed", "More than 200 files changed": the line's count, null when unknown. */
export const filesChangedWords = (files: SliceFiles | null): string | null => {
  if (!counted(files)) return null;
  return files.more
    ? `More than ${countWords(files.count, "file", "files")} changed`
    : `${countWords(files.count, "file", "files")} changed`;
};

/** The line's label: "Checkpoint · 3 files changed", or "Checkpoint" when the count is unknown. */
export const checkpointLabel = (mark: CheckpointMark): string => {
  const changed = filesChangedWords(mark.files);
  return changed === null ? "Checkpoint" : `Checkpoint · ${changed}`;
};

/** The paths the details name, and how many more there are: "and 4 more". */
export const pathsShown = (
  files: SliceFiles,
): { readonly paths: ReadonlyArray<string>; readonly rest: string | null } => {
  const rest = files.count - files.paths.length;
  return {
    paths: files.paths,
    rest: rest > 0 ? (files.more ? "and more" : `and ${rest.toLocaleString("en")} more`) : null,
  };
};

/** Whether another session took checkpoints in the worktree: a turn's files can include its work. */
export const sharedWorktree = (
  sessionId: string,
  chain: ReadonlyArray<{ readonly sessionId: string | null }>,
): boolean =>
  chain.some((checkpoint) => checkpoint.sessionId !== null && checkpoint.sessionId !== sessionId);
