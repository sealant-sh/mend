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
  /** How Mend came to take it; older readers may leave it out. */
  readonly trigger?: string;
  /** The conversation turn whose end it was taken for (SLNT-1263); absent for any other. */
  readonly turnId?: string;
  /** Why Mend can't confirm a turn's checkpoint holds exactly that turn's files. */
  readonly unconfirmed?: string;
}

/**
 * The checkpoints going back to a checkpoint takes (SLNT-1259): the files saved first, and the
 * files once back. They are the restore's, which has a line of its own, never a turn's.
 */
const RESTORE_TRIGGERS: ReadonlySet<string> = new Set(["restore-save", "restore"]);

/** A turn as its checkpoint is found: its place, whether it ended, and when it began. */
export interface TurnTimes extends AgentTurnDto {
  readonly startedAt: string | null;
}

/** One ended turn's checkpoint, and the one the worktree stood at when the turn began. */
export interface TurnCheckpoint {
  readonly turnId: string;
  /**
   * The checkpoint Mend took when the turn ended, which names the turn; for a turn from before
   * Mend named them, the last checkpoint this session took from the turn's start until the next
   * turn's.
   */
  readonly to: ChainCheckpoint;
  /** The newest checkpoint of the chain, any session's, taken before the turn began. */
  readonly from: ChainCheckpoint | null;
}

const millis = (at: Date | string): number => new Date(at).getTime();

/**
 * Each ended turn's checkpoint: the one Mend took when it ended, which names the turn (SLNT-1263).
 * Times can't say which turn a checkpoint belongs to: one taken as a turn ended can land after the
 * next turn began. A turn from before Mend named them takes the last checkpoint this session took
 * between the turn's start and the next turn's, among those that name no turn (one taken after
 * it, by a review or by hand, before the next message is the same turn's). It starts from the
 * newest checkpoint of the whole chain taken before the turn began, or the turn before's when that
 * one landed later. A turn still running, or one Mend took no checkpoint for, has none. The t3code
 * gateway's `turnSlicesOf` follows the same rule.
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
    const to =
      byOrdinal.findLast(
        (checkpoint) => checkpoint.turnId === turn.id && checkpoint.sessionId === sessionId,
      ) ??
      byOrdinal.findLast(
        (checkpoint) =>
          checkpoint.ordinal > 0 &&
          checkpoint.sessionId === sessionId &&
          checkpoint.turnId === undefined &&
          !RESTORE_TRIGGERS.has(checkpoint.trigger ?? "") &&
          millis(checkpoint.createdAt) >= start &&
          millis(checkpoint.createdAt) < end,
      );
    if (to === undefined) return [];
    // Where the turn started: the newest checkpoint taken before it began, or the turn before's,
    // which can land after this one began.
    const previous = sorted[index - 1];
    const from =
      byOrdinal.findLast(
        (checkpoint) =>
          checkpoint.ordinal < to.ordinal &&
          (millis(checkpoint.createdAt) < start ||
            (previous !== undefined && checkpoint.turnId === previous.id)),
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
  /** Why Mend can't confirm it holds exactly this turn's files; null when it can. */
  readonly unconfirmed: string | null;
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
        unconfirmed: turn.to.unconfirmed ?? null,
      },
    ];
  });

/**
 * What the line's details say of a checkpoint Mend couldn't confirm (SLNT-1263); null when it
 * could. It was still taken: the files it holds are real, only which turn's they are is in doubt.
 */
export const unconfirmedWords = (unconfirmed: string | null): string | null => {
  switch (unconfirmed) {
    case null:
      return null;
    case "next-turn-started":
      return "The next turn had already started when Mend took this checkpoint, so it can include that turn's first changes.";
    case "capture-behind":
      return "The workspace hadn't confirmed it saved this turn's last changes when Mend took this checkpoint, so some may be missing.";
    default:
      return "Mend couldn't confirm this checkpoint holds exactly this turn's changes.";
  }
};

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
