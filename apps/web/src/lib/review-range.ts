import type { OpenReviewResultDto, ReviewCommentDto } from "./api.ts";
import { TRIGGER_WORDS } from "./record-rows.ts";
import { countWords } from "./review-comments.ts";

/**
 * Second look (Doop page 4; SLNT-1176): which checkpoints a review covers, and what the agent did
 * with the comments sent to it. A range is the plain diff from its first checkpoint to its last;
 * "since your last review" starts at the checkpoint where the person last sent comments. The
 * agent's answer under a comment is read from the record: the turn the comments started, its last
 * message, and whether the code the comment points at changed.
 */

/** What the range chip says: "Since your last review · checkpoint 7 to 9". */
export interface RangeLabel {
  readonly range: string;
  readonly detail: string;
}

/** What the label reads of an opened review: its two checkpoints' numbers and its range. */
interface Opened {
  readonly checkpointA: { readonly ordinal: number };
  readonly checkpointB: { readonly ordinal: number };
  readonly range?: OpenReviewResultDto["range"];
}

/**
 * The words for the range a review was opened over; `base` names where the change starts.
 * `fixedEnd` says the person picked where it ends: otherwise a review from the base is the whole
 * change as it stands, even when the server reused an earlier checkpoint holding the same files.
 */
export const rangeLabel = (opened: Opened, base: string, fixedEnd: boolean): RangeLabel => {
  const from = opened.checkpointA.ordinal;
  const to = opened.checkpointB.ordinal;
  const kind = opened.range?.kind ?? "whole";
  // A range with a chosen end is two checkpoints, even when it starts at your last review.
  if (kind === "since-last-review" && !fixedEnd)
    return { range: "Since your last review", detail: `checkpoint ${from} to ${to}` };
  if (from === 0)
    return fixedEnd
      ? { range: `Up to checkpoint ${to}`, detail: `${base} to checkpoint ${to}` }
      : { range: "Whole change", detail: `${base} to checkpoint ${to}` };
  return { range: "Checkpoints", detail: `${from} to ${to}` };
};

/** "Turn ended", "A command settled": what a checkpoint was taken for. */
export const checkpointWords = (checkpoint: { readonly trigger: string }): string => {
  const words = TRIGGER_WORDS[checkpoint.trigger] ?? checkpoint.trigger;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** One row of "Up to a checkpoint": its number, what it was, and how it stands to your review. */
export interface CheckpointRow {
  readonly id: string;
  readonly ordinal: number;
  readonly words: string;
  readonly createdAt: Date;
  readonly mark: "new" | "last-review" | null;
}

/**
 * The worktree's checkpoints for the picker, newest first, the base (ordinal 0) left out: a
 * review up to the base would be empty. Those after your last review read New.
 */
export const checkpointRows = (
  chain: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly trigger: string;
    readonly createdAt: Date;
  }>,
  lastReview: { readonly checkpointId: string; readonly ordinal: number } | null,
): ReadonlyArray<CheckpointRow> =>
  chain
    .filter((checkpoint) => checkpoint.ordinal > 0)
    .toSorted((a, b) => b.ordinal - a.ordinal)
    .map((checkpoint) => ({
      id: checkpoint.id,
      ordinal: checkpoint.ordinal,
      words: checkpointWords(checkpoint),
      createdAt: new Date(checkpoint.createdAt),
      mark:
        lastReview === null
          ? null
          : checkpoint.id === lastReview.checkpointId
            ? "last-review"
            : checkpoint.ordinal > lastReview.ordinal
              ? "new"
              : null,
    }));

/**
 * The checkpoints the worktree's files can go back to (SLNT-1259), newest first: every one of the
 * chain, the base included, which puts the files back to where the change starts.
 */
export const goBackChoicesOf = (
  chain: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly trigger: string;
    readonly createdAt: Date;
  }>,
): ReadonlyArray<{
  readonly id: string;
  readonly ordinal: number;
  readonly words: string;
  readonly createdAt: Date;
}> =>
  chain
    .toSorted((a, b) => b.ordinal - a.ordinal)
    .map((checkpoint) => ({
      id: checkpoint.id,
      ordinal: checkpoint.ordinal,
      words: checkpoint.ordinal === 0 ? "Where the change starts" : checkpointWords(checkpoint),
      createdAt: new Date(checkpoint.createdAt),
    }));

const baseName = (path: string): string => path.split("/").at(-1) ?? path;

/**
 * The toolbar's note on a range that starts after the base: how many files changed in it, and
 * the change's files it doesn't touch. Null on a whole-change review.
 */
export const rangeNoteWords = (
  kind: "whole" | "since-last-review" | "custom",
  files: number,
  unchanged: ReadonlyArray<string> | undefined,
): string | null => {
  if (kind === "whole") return null;
  const changed =
    kind === "since-last-review"
      ? files === 0
        ? "Nothing changed since your last review."
        : `${countWords(files, "file", "files")} changed since your last review.`
      : files === 0
        ? "Nothing changed between these checkpoints."
        : `${countWords(files, "file", "files")} changed between these checkpoints.`;
  const left = unchanged ?? [];
  if (left.length === 0) return changed;
  const names =
    left.length <= 2
      ? `${left.map(baseName).join(" and ")} didn't change.`
      : `${countWords(left.length, "other file", "other files")} didn't change.`;
  return `${changed} ${names}`;
};

type Answer = NonNullable<ReviewCommentDto["answers"]>[number];
type Reply = NonNullable<ReviewCommentDto["replies"]>[number];

/** Whether an answer's turn has ended, one way or another. */
export const answerEnded = (answer: Pick<Answer, "turnStatus">): boolean =>
  answer.turnStatus !== "queued" && answer.turnStatus !== "running";

/** The newest answer under a comment, or null. */
export const latestAnswer = (comment: Pick<ReviewCommentDto, "answers">): Answer | null =>
  comment.answers?.at(-1) ?? null;

/** "Changed the code at checkpoint 8", "No code change", or null when Mend can't say. */
export const outcomeWords = (answer: Pick<Answer, "outcome" | "changedAt">): string | null => {
  if (answer.outcome === "changed-code")
    return answer.changedAt === null
      ? "Changed the code"
      : `Changed the code at checkpoint ${answer.changedAt.ordinal}`;
  if (answer.outcome === "no-code-change") return "No code change";
  return null;
};

/**
 * What a comment's row in the column says about the agent's answer: "Replied and changed the
 * code", "Replied, no code change", "Replied", or that it is still working. Null when none came.
 */
export const answerNoteWords = (comment: Pick<ReviewCommentDto, "answers">, agent: string) => {
  const answer = latestAnswer(comment);
  if (answer === null) return null;
  if (!answerEnded(answer)) return `${agent} is working on it`;
  if (answer.turnStatus !== "completed") return `${agent} stopped before answering`;
  if (answer.outcome === "changed-code") return "Replied and changed the code";
  if (answer.outcome === "no-code-change") return "Replied, no code change";
  return "Replied";
};

/** One entry under a comment, in time order: a person's reply, or the agent's answer. */
export type ThreadEntry =
  | { readonly kind: "reply"; readonly reply: Reply; readonly at: number }
  | { readonly kind: "answer"; readonly answer: Answer; readonly at: number };

/** The replies and answers under a comment, oldest first. */
export const threadOf = (
  comment: Pick<ReviewCommentDto, "replies" | "answers">,
): ReadonlyArray<ThreadEntry> =>
  [
    ...(comment.replies ?? []).map(
      (reply): ThreadEntry => ({ kind: "reply", reply, at: new Date(reply.createdAt).getTime() }),
    ),
    ...(comment.answers ?? []).map(
      (answer): ThreadEntry => ({ kind: "answer", answer, at: new Date(answer.at).getTime() }),
    ),
  ].toSorted((a, b) => a.at - b.at);

/**
 * "Sent in turn 4", and "was line 31" when the comment now sits on other lines than it was
 * written on (an edit rewrote or moved them).
 */
export const sentWords = (
  comment: Pick<ReviewCommentDto, "sentToSessionId" | "sentInTurn" | "placement" | "line">,
): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  if (comment.sentToSessionId !== null)
    parts.push(
      comment.sentInTurn === null || comment.sentInTurn === undefined
        ? "Sent"
        : `Sent in turn ${comment.sentInTurn}`,
    );
  const placement = comment.placement;
  if (
    placement !== undefined &&
    comment.line !== null &&
    placement.mapping === "moved" &&
    (placement.linesChanged || placement.startLine !== comment.line)
  )
    parts.push(`was line ${comment.line}`);
  return parts;
};

/**
 * Where a comment sits on the review shown: the carried lines when the list was read for this
 * review, else the lines it was written on. Null when it is no longer placed in the diff.
 */
export const placedLines = (
  comment: Pick<ReviewCommentDto, "line" | "endLine" | "placement" | "file">,
): {
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly endLine: number;
} | null => {
  if (comment.file === null || comment.line === null) return null;
  const placement = comment.placement;
  if (placement === undefined)
    return {
      path: comment.file,
      side: "new",
      line: comment.line,
      endLine: comment.endLine ?? comment.line,
    };
  if (placement.mapping === "not-found" || placement.startLine === null) return null;
  return {
    path: placement.path ?? comment.file,
    side: placement.side ?? "new",
    line: placement.startLine,
    endLine: placement.endLine ?? placement.startLine,
  };
};

/** The open, unsent replies under a person's comments: what Send sends beside new comments. */
export const unsentReplies = (comments: ReadonlyArray<ReviewCommentDto>): ReadonlyArray<Reply> =>
  comments.flatMap((comment) =>
    (comment.replies ?? []).filter(
      (reply) => reply.state === "open" && reply.sentToSessionId === null,
    ),
  );

/**
 * The band over a whole-change review once the agent has answered the comments you last sent:
 * how many it answered and how many of those it changed code for, and where you last reviewed.
 * Null when there is no last review, the change hasn't moved past it, or the answers aren't in.
 */
export const finishedWords = (
  comments: ReadonlyArray<ReviewCommentDto>,
  lastReview: { readonly ordinal: number } | null,
  latest: number,
  /** The agent's name for a harness: the band names the agent that answered. */
  agentName: (harness: string) => string,
): { readonly title: string; readonly detail: string } | null => {
  if (lastReview === null || latest <= lastReview.ordinal) return null;
  const answered = comments.filter((comment) => latestAnswer(comment) !== null);
  if (answered.length === 0) return null;
  // The newest send's comments: those whose newest answer came from the newest turn.
  const newest = Math.max(...answered.map((comment) => latestAnswer(comment)?.turnOrdinal ?? 0));
  const sent = answered.filter((comment) => latestAnswer(comment)?.turnOrdinal === newest);
  if (sent.some((comment) => !answerEnded(latestAnswer(comment) ?? { turnStatus: "running" })))
    return null;
  const changed = sent.filter(
    (comment) => latestAnswer(comment)?.outcome === "changed-code",
  ).length;
  const count = countWords(sent.length, "comment", "comments");
  const agent = agentName(latestAnswer(sent[0] ?? {})?.harness ?? "");
  const where = `Checkpoint ${lastReview.ordinal} is where you last reviewed, and the change is now at checkpoint ${latest}.`;
  const did =
    changed === 0
      ? "It answered, with no code change."
      : changed === sent.length
        ? "It answered and changed the code."
        : `It answered and changed the code for ${changed} of them.`;
  return { title: `${agent} finished working on your ${count}.`, detail: `${did} ${where}` };
};
