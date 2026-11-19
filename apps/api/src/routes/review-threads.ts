import { CheckpointsRepo, FollowUpsRepo, type FollowUpTurn, ReviewCommentsRepo } from "@mend/db";
import type { ChangeId, ProjectId, ReviewCommentId, WorktreeId } from "@mend/domain";
import {
  AgentAnswer,
  AnswerCheckpoint,
  type Checkpoint,
  ReviewComment,
  ReviewCommentPlacement,
  type ReviewReply,
  type ReviewSlice,
} from "@mend/domain/workbench";
import { WorktreeReads } from "@mend/sessions";
import { Effect } from "effect";

import { parseReviewDiff } from "./review-diff.ts";
import { type CarryFile, carryTarget, targetChanged } from "./review-placement.ts";

/** The change a list of comments belongs to, and where its worktree's git lives. */
export interface ThreadsChange {
  readonly id: ChangeId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
}

type Lines = { readonly startLine: number; readonly endLine: number } | null;

/** A comment's target on one side of its own slice: the checkpoint, path and lines it names. */
interface SideTarget {
  readonly checkpointId: Checkpoint["id"];
  /** On the slice's old side: the comment's lines are in its "from" checkpoint. */
  readonly onOld: boolean;
  readonly side: "old" | "new" | null;
  readonly path: string | null;
  readonly lines: Lines;
}

const linesOf = (startLine: number | null, endLine: number | null): Lines =>
  startLine === null ? null : { startLine, endLine: endLine ?? startLine };

/**
 * Where a comment points, on the side of its slice that holds its lines: the new side (the slice's
 * "to" checkpoint) for a comment on added or kept lines or on a file that still exists, the old
 * side for a comment on removed lines or a deleted file. Null for a whole-change comment and for a
 * legacy comment with no slice.
 */
const sideTarget = (comment: ReviewComment): SideTarget | null => {
  const anchor = comment.anchor;
  if (anchor === null) return null;
  if (anchor.oldPath === null && anchor.newPath === null) return null;
  const old = anchor.side === "old" || (anchor.side === null && anchor.newPath === null);
  return {
    checkpointId: old ? anchor.checkpointAId : anchor.checkpointBId,
    onOld: old,
    side: anchor.side,
    path: old ? anchor.oldPath : anchor.newPath,
    lines: linesOf(anchor.startLine, anchor.endLine),
  };
};

/**
 * Every comment on the change, each with its replies, the agent's answers and, given a slice,
 * where it sits on that slice. Replies are only ever listed under their comment, so a client that
 * predates them sees only comments, exactly as before.
 */
export const reviewThreads = Effect.fn("SessionChanges.reviewThreads")(function* (
  change: ThreadsChange,
  slice: ReviewSlice | null,
) {
  const commentsRepo = yield* ReviewCommentsRepo;
  const followUps = yield* FollowUpsRepo;
  const checkpointsRepo = yield* CheckpointsRepo;
  const reads = yield* WorktreeReads;
  const comments = yield* commentsRepo.listForChange(change.id);
  const replies = yield* commentsRepo.listReplies(change.id);
  const turns = yield* followUps.turnsForChange(change.id);
  const chain = yield* checkpointsRepo.listForWorktree(change.worktreeId);
  const byId = new Map(chain.map((checkpoint) => [checkpoint.id, checkpoint]));

  // One diff per pair of commits, however many comments ask for it.
  const diffs = new Map<string, ReadonlyArray<CarryFile>>();
  const filesBetween = (from: string, to: string) =>
    Effect.gen(function* () {
      const key = `${from}..${to}`;
      const known = diffs.get(key);
      if (known !== undefined) return known;
      const patch = (yield* reads.diffRange(change.projectId, change.worktreeId, from, to, {
        contextLines: 0,
      })).value;
      const facts = (yield* reads.diffFileFacts(change.projectId, change.worktreeId, from, to))
        .value;
      const files = parseReviewDiff(patch, facts);
      diffs.set(key, files);
      return files;
    });

  /** The target carried from its own checkpoint to `to`; null if a checkpoint isn't known. */
  const carriedTo = (target: SideTarget, to: Checkpoint) =>
    Effect.gen(function* () {
      const from = byId.get(target.checkpointId);
      if (from === undefined) return null;
      if (from.sha === to.sha) {
        return {
          kind: "placed" as const,
          path: target.path,
          lines: target.lines,
          linesChanged: false,
          renamed: false,
        };
      }
      return carryTarget(yield* filesBetween(from.sha, to.sha), target.path, target.lines);
    });

  const placementOn = (comment: ReviewComment, onto: ReviewSlice) =>
    Effect.gen(function* () {
      if (comment.anchor === null) return undefined;
      const target = sideTarget(comment);
      if (target === null) {
        return new ReviewCommentPlacement({
          reviewSliceId: onto.id,
          mapping: "anchored",
          path: null,
          side: null,
          startLine: null,
          endLine: null,
          linesChanged: false,
        });
      }
      const to = byId.get(target.onOld ? onto.checkpointAId : onto.checkpointBId);
      const carried = to === undefined ? null : yield* carriedTo(target, to);
      if (carried === null || carried.kind === "gone") {
        return new ReviewCommentPlacement({
          reviewSliceId: onto.id,
          mapping: "not-found",
          path: null,
          side: target.side,
          startLine: null,
          endLine: null,
          linesChanged: carried !== null,
        });
      }
      const still =
        !carried.renamed &&
        !carried.linesChanged &&
        carried.lines?.startLine === target.lines?.startLine &&
        carried.lines?.endLine === target.lines?.endLine;
      return new ReviewCommentPlacement({
        reviewSliceId: onto.id,
        mapping: still ? "anchored" : "moved",
        path: carried.path,
        side: target.side,
        startLine: carried.lines?.startLine ?? null,
        endLine: carried.lines?.endLine ?? null,
        linesChanged: carried.linesChanged,
      });
    });

  // Which comment a sent id stands for: a reply answers under its comment.
  const rootOf = new Map<ReviewCommentId, ReviewCommentId>(
    replies.map((reply) => [reply.id, reply.parentId]),
  );
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]));

  /** What the code did between the send and the end of the turn, for one comment. */
  const outcomeOf = (comment: ReviewComment, turn: FollowUpTurn) =>
    Effect.gen(function* () {
      const none = { outcome: null, changedAt: null } as const;
      const ended = turn.endedAt !== null && turn.status !== "queued" && turn.status !== "running";
      const sent =
        turn.followUp.checkpointBId === null ? undefined : byId.get(turn.followUp.checkpointBId);
      const target = sideTarget(comment);
      if (!ended || turn.endedAt === null || sent === undefined || target === null) return none;
      // At the send, where the comment pointed: carried from its own slice when it was written on
      // an earlier one.
      const atSend = yield* carriedTo(target, sent);
      if (atSend === null || atSend.kind === "gone") return none;
      const endedAt = turn.endedAt;
      const after = chain.filter((checkpoint) => checkpoint.ordinal > sent.ordinal);
      // The turn's closing checkpoint: the first one taken once it ended.
      const closing = after.find((checkpoint) => checkpoint.createdAt >= endedAt);
      const window =
        closing === undefined ? after : after.filter((cp) => cp.ordinal <= closing.ordinal);
      for (const checkpoint of window) {
        const changed = targetChanged(
          yield* filesBetween(sent.sha, checkpoint.sha),
          atSend.path,
          atSend.lines,
        );
        if (changed === null) return none;
        if (changed) {
          return {
            outcome: "changed-code" as const,
            changedAt: new AnswerCheckpoint({
              checkpointId: checkpoint.id,
              ordinal: checkpoint.ordinal,
            }),
          };
        }
      }
      return closing === undefined ? none : { outcome: "no-code-change" as const, changedAt: null };
    });

  const answers = new Map<ReviewCommentId, Array<AgentAnswer>>();
  const sentInTurn = new Map<ReviewCommentId, number>();
  for (const turn of turns) {
    const roots = new Set(turn.followUp.commentIds.map((id) => rootOf.get(id) ?? id));
    for (const id of turn.followUp.commentIds) {
      if (!rootOf.has(id) && !sentInTurn.has(id)) sentInTurn.set(id, turn.ordinal);
    }
    for (const rootId of roots) {
      const comment = commentsById.get(rootId);
      if (comment === undefined) continue;
      // Clients that predate answers read this list too: a git read that fails leaves the outcome
      // unknown rather than failing the list.
      const { outcome, changedAt } = yield* outcomeOf(comment, turn).pipe(
        Effect.catch((error) =>
          Effect.logWarning("review threads: the answer's outcome could not be read").pipe(
            Effect.annotateLogs({ changeId: change.id, followUpId: turn.followUp.id, error }),
            Effect.as({ outcome: null, changedAt: null }),
          ),
        ),
      );
      const list = answers.get(rootId) ?? [];
      list.push(
        new AgentAnswer({
          followUpId: turn.followUp.id,
          sessionId: turn.followUp.sessionId,
          harness: turn.harness,
          turnOrdinal: turn.ordinal,
          turnStatus: turn.status,
          body: turn.lastMessage,
          outcome,
          changedAt,
          at: turn.endedAt ?? turn.startedAt ?? turn.createdAt,
        }),
      );
      answers.set(rootId, list);
    }
  }

  const repliesOf = new Map<ReviewCommentId, Array<ReviewReply>>();
  for (const reply of replies) {
    repliesOf.set(reply.parentId, [...(repliesOf.get(reply.parentId) ?? []), reply]);
  }

  return yield* Effect.forEach(comments, (comment) =>
    Effect.gen(function* () {
      const placement = slice === null ? undefined : yield* placementOn(comment, slice);
      return new ReviewComment({
        ...comment,
        parentId: null,
        replies: repliesOf.get(comment.id) ?? [],
        answers: answers.get(comment.id) ?? [],
        sentInTurn: sentInTurn.get(comment.id) ?? null,
        ...(placement === undefined ? {} : { placement }),
      });
    }),
  );
});
