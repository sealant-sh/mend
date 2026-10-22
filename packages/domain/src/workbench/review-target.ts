import type { ReviewAnchorSide } from "./review-comment.ts";

export interface ReviewTargetHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly contextHash: string;
}

export interface ReviewTargetFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: ReadonlyArray<ReviewTargetHunk>;
}

export interface ReviewCommentTarget {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: ReviewAnchorSide | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly hunkContextHash: string | null;
}

export interface LineAnchorTarget {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: ReviewAnchorSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly hunkContextHash: string;
}

const fileOf = (
  files: ReadonlyArray<ReviewTargetFile>,
  target: Pick<ReviewCommentTarget, "oldPath" | "newPath">,
): ReviewTargetFile | undefined =>
  files.find(
    (candidate) => candidate.oldPath === target.oldPath && candidate.newPath === target.newPath,
  );

export const lineAnchorExists = (
  files: ReadonlyArray<ReviewTargetFile>,
  target: LineAnchorTarget,
): boolean => {
  const file = fileOf(files, target);
  if (file === undefined || target.startLine < 1 || target.endLine < target.startLine) return false;
  return file.hunks.some((hunk) => {
    const rangeStart = target.side === "old" ? hunk.oldStart : hunk.newStart;
    const count = target.side === "old" ? hunk.oldLines : hunk.newLines;
    if (count === 0) return false;
    const rangeEnd = rangeStart + count - 1;
    return (
      hunk.contextHash === target.hunkContextHash &&
      target.startLine >= rangeStart &&
      target.endLine <= rangeEnd
    );
  });
};

export const reviewTargetExists = (
  files: ReadonlyArray<ReviewTargetFile>,
  target: ReviewCommentTarget,
): boolean => {
  const hasPath = target.oldPath !== null || target.newPath !== null;
  const hasNoLocation =
    target.side === null &&
    target.startLine === null &&
    target.endLine === null &&
    target.hunkContextHash === null;
  if (hasNoLocation) return !hasPath || fileOf(files, target) !== undefined;
  return (
    hasPath &&
    target.side !== null &&
    target.startLine !== null &&
    target.endLine !== null &&
    target.hunkContextHash !== null &&
    lineAnchorExists(files, {
      oldPath: target.oldPath,
      newPath: target.newPath,
      side: target.side,
      startLine: target.startLine,
      endLine: target.endLine,
      hunkContextHash: target.hunkContextHash,
    })
  );
};
