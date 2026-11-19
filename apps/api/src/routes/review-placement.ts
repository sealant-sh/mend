import type { DiffFileStatus } from "@mend/store";

/**
 * Carrying a review comment from the checkpoint it was written on to another checkpoint, through
 * git's zero-context diff between the two (SLNT-1176, "Second look"). Pure: the caller reads the
 * diff.
 */

/** One `@@ -a,b +c,d @@` hunk of a zero-context diff. */
export interface LineHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

/** One file of the diff between the two checkpoints: its paths, what git saw, its hunks. */
export interface CarryFile {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly hunks: ReadonlyArray<LineHunk>;
}

export type CarriedLines =
  | {
      readonly kind: "placed";
      readonly startLine: number;
      readonly endLine: number;
      /** An edit rewrote some of the lines, or put new ones between them. */
      readonly linesChanged: boolean;
    }
  /** Every line was deleted and nothing replaced them. */
  | { readonly kind: "gone" };

/** The last line a hunk covers on one side; for an empty side, the line it sits after. */
const lastOld = (hunk: LineHunk) => hunk.oldStart + hunk.oldLines - 1;

/** Whether the hunk sits wholly before line `line` of the old side. */
const before = (hunk: LineHunk, line: number) =>
  hunk.oldLines === 0 ? hunk.oldStart < line : lastOld(hunk) < line;

/** Whether the hunk removes or rewrites old line `line`. */
const covers = (hunk: LineHunk, line: number) =>
  hunk.oldLines > 0 && hunk.oldStart <= line && line <= lastOld(hunk);

/** Where an old line no hunk touches sits on the new side. */
const shifted = (hunks: ReadonlyArray<LineHunk>, line: number): number =>
  hunks
    .filter((hunk) => before(hunk, line))
    .reduce((at, hunk) => at + hunk.newLines - hunk.oldLines, line);

/**
 * Lines `startLine..endLine` of the old side, carried to the new side. Lines no edit touched move
 * by the lines added and removed above them. Lines an edit rewrote become the lines that replaced
 * them, so a comment on a line the agent then changed sits on the change. Lines an edit only
 * deleted, with nothing in their place, are gone.
 */
export const carryLines = (
  hunks: ReadonlyArray<LineHunk>,
  startLine: number,
  endLine: number,
): CarriedLines => {
  const touching = hunks.filter(
    (hunk) =>
      (hunk.oldLines > 0 && hunk.oldStart <= endLine && lastOld(hunk) >= startLine) ||
      // Lines put between two of the range's own lines.
      (hunk.oldLines === 0 && hunk.oldStart >= startLine && hunk.oldStart < endLine),
  );
  if (touching.length === 0) {
    return {
      kind: "placed",
      startLine: shifted(hunks, startLine),
      endLine: shifted(hunks, endLine),
      linesChanged: false,
    };
  }
  const newLines = touching.flatMap((hunk) =>
    hunk.newLines === 0 ? [] : [hunk.newStart, hunk.newStart + hunk.newLines - 1],
  );
  const startKept = !hunks.some((hunk) => covers(hunk, startLine));
  const endKept = !hunks.some((hunk) => covers(hunk, endLine));
  if (startKept) newLines.push(shifted(hunks, startLine));
  if (endKept) newLines.push(shifted(hunks, endLine));
  if (newLines.length === 0) return { kind: "gone" };
  return {
    kind: "placed",
    startLine: Math.min(...newLines),
    endLine: Math.max(...newLines),
    linesChanged: true,
  };
};

export type CarriedTarget =
  | {
      readonly kind: "placed";
      /** The file's path on the far side; null on a whole-change target. */
      readonly path: string | null;
      /** Null on a file or whole-change target. */
      readonly lines: { readonly startLine: number; readonly endLine: number } | null;
      readonly linesChanged: boolean;
      /** The path changed (a rename). */
      readonly renamed: boolean;
    }
  | { readonly kind: "gone" };

/**
 * A comment's target on one side, carried across the diff `files` (from the comment's checkpoint
 * to the far one). `path` null is a whole-change target, always placed. A file the diff doesn't
 * list didn't change: the target stays as it is. A deleted file takes its comments with it.
 */
export const carryTarget = (
  files: ReadonlyArray<CarryFile>,
  path: string | null,
  lines: { readonly startLine: number; readonly endLine: number } | null,
): CarriedTarget => {
  if (path === null) {
    return { kind: "placed", path: null, lines: null, linesChanged: false, renamed: false };
  }
  const file = files.find((candidate) => (candidate.oldPath ?? candidate.newPath) === path);
  if (file === undefined) {
    return { kind: "placed", path, lines, linesChanged: false, renamed: false };
  }
  if (file.newPath === null || file.status === "deleted") return { kind: "gone" };
  const renamed = file.newPath !== path;
  if (lines === null) {
    return { kind: "placed", path: file.newPath, lines: null, linesChanged: false, renamed };
  }
  const carried = carryLines(file.hunks, lines.startLine, lines.endLine);
  if (carried.kind === "gone") return carried;
  return {
    kind: "placed",
    path: file.newPath,
    lines: { startLine: carried.startLine, endLine: carried.endLine },
    linesChanged: carried.linesChanged,
    renamed,
  };
};

/**
 * Whether the code a comment points at changed across the diff `files`: its lines rewritten or
 * gone, or, for a comment on a file, anything in that file. Null on a whole-change comment: no edit
 * can be tied to it.
 */
export const targetChanged = (
  files: ReadonlyArray<CarryFile>,
  path: string | null,
  lines: { readonly startLine: number; readonly endLine: number } | null,
): boolean | null => {
  if (path === null) return null;
  const carried = carryTarget(files, path, lines);
  if (carried.kind === "gone") return true;
  if (lines === null) {
    return files.some((file) => (file.oldPath ?? file.newPath) === path);
  }
  return carried.linesChanged;
};
