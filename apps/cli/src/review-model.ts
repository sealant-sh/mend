import * as path from "node:path";

export interface ChangedFileLike {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export type ReviewLineKind = "context" | "addition" | "deletion";
export type ReviewFileStatus = "added" | "deleted" | "renamed" | "modified";

export interface ReviewLine {
  readonly kind: ReviewLineKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  /** Zero-based rendered row in OpenTUI's unified layout. */
  readonly unifiedRow: number;
  /** Zero-based rendered row in OpenTUI's split layout. */
  readonly splitRow: number;
  readonly hunk: number;
  readonly commentable: boolean;
}

export interface ReviewHunk {
  readonly index: number;
  readonly header: string;
  readonly unifiedRow: number;
  readonly splitRow: number;
}

export interface ReviewFile extends ChangedFileLike {
  readonly patch: string;
  readonly filetype: string | undefined;
  readonly status: ReviewFileStatus;
  readonly binary: boolean;
  readonly likelyGenerated: boolean;
  readonly lines: ReadonlyArray<ReviewLine>;
  readonly hunks: ReadonlyArray<ReviewHunk>;
  readonly unifiedRows: number;
  readonly splitRows: number;
}

const FILETYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  css: "css",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const filetypeOf = (name: string): string | undefined => {
  const extension = path.extname(name).slice(1).toLowerCase();
  return extension === "" ? undefined : (FILETYPE_BY_EXTENSION[extension] ?? extension);
};

const statusOf = (patch: string): ReviewFileStatus => {
  if (/^new file mode /m.test(patch)) return "added";
  if (/^deleted file mode /m.test(patch)) return "deleted";
  if (/^rename (?:from|to) /m.test(patch)) return "renamed";
  return "modified";
};

const isLikelyGenerated = (name: string): boolean =>
  /(^|\/)(?:dist|build|generated)(?:\/|$)/i.test(name) ||
  /(?:\.generated\.|\.min\.(?:js|css)$|(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$)/i.test(
    name,
  );

/** A legible terminal whitespace mode that preserves git's control prefixes. */
export const visibleWhitespace = (patch: string): string => {
  let inHunk = false;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) inHunk = false;
      if (line.startsWith("@@ ")) inHunk = true;
      const hunkContent = inHunk && /^[+ -]/.test(line);
      if (!hunkContent) return line;
      const prefix = line.slice(0, 1);
      const content = line.slice(1).replaceAll("\t", "→····").replaceAll(" ", "·");
      return `${prefix}${content}`;
    })
    .join("\n");
};

/**
 * Git is the source of this wire value, so a file begins only at a column-zero
 * `diff --git` header. A changed source line is prefixed with +/− and cannot
 * accidentally split the patch.
 */
const splitFilePatches = (diff: string): ReadonlyArray<string> => {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? diff.length;
    const patch = diff.slice(start, end);
    return patch.endsWith("\n") ? patch : `${patch}\n`;
  });
};

interface MutableReviewLine {
  kind: ReviewLineKind;
  oldLine: number | null;
  newLine: number | null;
  unifiedRow: number;
  splitRow: number;
  hunk: number;
  commentable: boolean;
}

const parseRows = (
  patch: string,
): {
  readonly lines: ReadonlyArray<ReviewLine>;
  readonly hunks: ReadonlyArray<ReviewHunk>;
  readonly unifiedRows: number;
  readonly splitRows: number;
} => {
  const patchLines = patch.split("\n");
  const lines: Array<MutableReviewLine> = [];
  const hunks: Array<ReviewHunk> = [];
  let unifiedRow = 0;
  let splitRow = 0;
  let hunkIndex = -1;
  let oldLine = 0;
  let newLine = 0;

  for (let index = 0; index < patchLines.length; index += 1) {
    const header = patchLines[index] ?? "";
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
    if (hunkMatch === null) continue;

    hunkIndex += 1;
    oldLine = Number(hunkMatch[1]);
    newLine = Number(hunkMatch[2]);
    hunks.push({ index: hunkIndex, header, unifiedRow, splitRow });

    const body: Array<{ readonly kind: ReviewLineKind }> = [];
    let bodyIndex = index + 1;
    while (bodyIndex < patchLines.length) {
      const bodyLine = patchLines[bodyIndex] ?? "";
      if (bodyLine.startsWith("@@ ")) break;
      if (bodyLine.startsWith("+")) {
        body.push({ kind: "addition" });
      } else if (bodyLine.startsWith("-")) {
        body.push({ kind: "deletion" });
      } else if (bodyLine.startsWith(" ")) {
        body.push({ kind: "context" });
      }
      bodyIndex += 1;
    }

    let cursor = 0;
    while (cursor < body.length) {
      const current = body[cursor];
      if (current?.kind === "context") {
        lines.push({
          kind: "context",
          oldLine,
          newLine,
          unifiedRow,
          splitRow,
          hunk: hunkIndex,
          commentable: true,
        });
        oldLine += 1;
        newLine += 1;
        unifiedRow += 1;
        splitRow += 1;
        cursor += 1;
        continue;
      }

      // Git groups a replacement as a run of deletions/additions. Unified
      // stacks every row; split aligns the Nth deletion with the Nth addition.
      const groupStart = cursor;
      while (cursor < body.length && body[cursor]?.kind !== "context") cursor += 1;
      const group = body.slice(groupStart, cursor);
      let deletionOffset = 0;
      let additionOffset = 0;
      for (const entry of group) {
        if (entry.kind === "deletion") {
          lines.push({
            kind: entry.kind,
            oldLine,
            newLine: null,
            unifiedRow,
            splitRow: splitRow + deletionOffset,
            hunk: hunkIndex,
            // ReviewComment persists a line number but no old/new side. Like
            // the web review, deletions therefore abstain instead of storing
            // a confidently wrong new-file anchor.
            commentable: false,
          });
          oldLine += 1;
          deletionOffset += 1;
        } else {
          lines.push({
            kind: entry.kind,
            oldLine: null,
            newLine,
            unifiedRow,
            splitRow: splitRow + additionOffset,
            hunk: hunkIndex,
            commentable: true,
          });
          newLine += 1;
          additionOffset += 1;
        }
        unifiedRow += 1;
      }
      splitRow += Math.max(deletionOffset, additionOffset);
    }

    index = bodyIndex - 1;
  }

  return { lines, hunks, unifiedRows: unifiedRow, splitRows: splitRow };
};

/** Public review seam: the API's live git diff becomes the terminal's files, hunks, and anchors. */
export const buildReviewFiles = (
  diff: string,
  stats: ReadonlyArray<ChangedFileLike>,
): ReadonlyArray<ReviewFile> => {
  const patches = splitFilePatches(diff);
  return stats.map((stat, index) => {
    const patch = patches[index] ?? "";
    const rows = parseRows(patch);
    return {
      ...stat,
      patch,
      filetype: filetypeOf(stat.path),
      status: statusOf(patch),
      binary: /^Binary files |^GIT binary patch$/m.test(patch),
      likelyGenerated: isLikelyGenerated(stat.path),
      ...rows,
    };
  });
};

export interface ReviewInstructionChange {
  readonly branch: string;
}

export interface ReviewInstructionComment {
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly body: string;
  readonly suggestion: string | null;
}

/** The mechanically assembled draft remains editable before the API receives it. */
export const assembleReviewInstruction = (
  change: ReviewInstructionChange,
  comments: ReadonlyArray<ReviewInstructionComment>,
): string => {
  const points = comments
    .map((comment, index) => {
      const anchor =
        comment.file === null
          ? "the change as a whole"
          : `${comment.file}${comment.line === null ? "" : `:${comment.line}${comment.endLine === null || comment.endLine === comment.line ? "" : `-${comment.endLine}`}`}`;
      const proposal =
        comment.suggestion === null
          ? ""
          : `\n   Proposed replacement:\n${comment.suggestion
              .split("\n")
              .map((line) => `   ${line}`)
              .join("\n")}`;
      return `${index + 1}. ${anchor} — ${comment.body}${proposal}`;
    })
    .join("\n");

  return `This is a follow-up on your earlier work in this worktree, responding to review feedback. The branch ${change.branch} is already checked out with your work on it: keep working there, and do not start a new branch or reset it.

Review comments:
${points}

Address each point using your own judgment about how. Check your work with the repository's own build, tests, or typecheck; a check that still fails is something to report, not to force green. Report honestly what you changed and what you did not — if a point cannot or should not be done, say so plainly.`;
};
