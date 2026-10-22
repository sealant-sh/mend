import { reviewTargetFile, targetFileFor, type ReviewCommentTarget } from "@mend/domain/workbench";

import type { PendingComment } from "./pending.js";
import type { ChangeFile, ServerComment } from "./review-wire.js";

/** A post on its way, kept before the request goes: a reload matches only what it made. */
export interface PostAttempt {
  /** The words and the target posted, exactly. */
  readonly body: string;
  readonly target: ReviewCommentTarget;
  /** Her name as Mend writes it on her comments; null when Mend could not say who she is. */
  readonly author: string | null;
  /** Every comment id on the change before the post: the one it made is not among them. */
  readonly before: ReadonlyArray<string>;
}

/**
 * The target for a pending comment in the slice it was written on: its lines when one hunk holds
 * them, else its file (the words then say which line, when it is on one), else the change as a
 * whole.
 */
export const commentTarget = (
  files: ReadonlyArray<ChangeFile>,
  comment: Pick<PendingComment, "path" | "line" | "endLine" | "body" | "anchor">,
): { readonly target: ReviewCommentTarget; readonly body: string } => {
  // Her reply under a Mend draft on the old side goes where the draft is: the base's lines.
  const side = comment.anchor?.side ?? null;
  const old = side === "old";
  const { line, endLine } = comment;
  const file = comment.path === null ? undefined : targetFileFor(files, comment.path, side);
  const hunk =
    line === null || endLine === null
      ? undefined
      : file?.hunks.find((candidate) => {
          const start = old ? candidate.oldStart : candidate.newStart;
          const lines = old ? candidate.oldLines : candidate.newLines;
          return lines > 0 && line >= start && endLine <= start + lines - 1;
        });
  if (file !== undefined && hunk !== undefined && line !== null && endLine !== null)
    return {
      target: {
        oldPath: file.oldPath,
        newPath: file.newPath,
        side: old ? "old" : "new",
        startLine: line,
        endLine,
        hunkContextHash: hunk.contextHash,
      },
      body: comment.body,
    };
  const where = line === null ? "" : `line ${line}: `;
  if (file !== undefined)
    return {
      target: {
        oldPath: file.oldPath,
        newPath: file.newPath,
        side: null,
        startLine: null,
        endLine: null,
        hunkContextHash: null,
      },
      body: `${where}${comment.body}`,
    };
  return {
    target: {
      oldPath: null,
      newPath: null,
      side: null,
      startLine: null,
      endLine: null,
      hunkContextHash: null,
    },
    body:
      comment.path === null
        ? comment.body
        : `${comment.path}${line === null ? "" : `:${line}`}: ${comment.body}`,
  };
};

/**
 * The comment a post in flight left on Mend, if it landed: one that was not there before the post,
 * not claimed by another item, written by her, with exactly the words and the target posted, on
 * the slice it was posted to. Mend trims the words it keeps.
 */
export const postedComment = (
  attempt: PostAttempt,
  sliceId: string,
  comments: ReadonlyArray<ServerComment>,
  claimed: ReadonlySet<string>,
): string | null => {
  const before = new Set(attempt.before);
  const { target } = attempt;
  return (
    comments.find(
      (comment) =>
        !before.has(comment.id) &&
        !claimed.has(comment.id) &&
        comment.author.kind === "reviewer" &&
        (attempt.author === null || comment.author.name === attempt.author) &&
        comment.body === attempt.body.trim() &&
        comment.anchor?.sliceId === sliceId &&
        comment.file === reviewTargetFile(target) &&
        comment.line === target.startLine &&
        comment.endLine === target.endLine,
    )?.id ?? null
  );
};
