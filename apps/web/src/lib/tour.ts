import type { ChangePassDto, ChangeTourDto, TourStopDto } from "./api.ts";
import type { ChangeFile } from "./change-files.ts";

/**
 * Mend's description of a change and its tour (Doop page 4, "Review tour"): the rules the Change
 * view's Description block and the tour's stops are drawn from. The model is
 * `packages/domain/src/workbench/tour.ts`; the tour never gives a verdict, and each stop says
 * whether the session's record backs it.
 */

/** What the Description block shows: each state replaces the block. */
export type DescriptionState =
  | { readonly kind: "writing" }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly detail: string | null }
  | { readonly kind: "ready"; readonly tour: ChangeTourDto };

/**
 * The block's state from the tour and the tour pass. A pass that is queued or running wins: the
 * person asked for a new description. A pass that failed after the tour it would have replaced
 * shows the failure; an older failure under a newer tour does not.
 */
export const descriptionState = (
  tour: ChangeTourDto | null,
  pass: ChangePassDto | null,
): DescriptionState => {
  if (pass !== null && (pass.status === "queued" || pass.status === "running"))
    return { kind: "writing" };
  const failed = pass !== null && pass.status === "failed";
  if (tour === null) return failed ? { kind: "failed", detail: pass.detail } : { kind: "none" };
  if (failed && new Date(pass.finishedAt ?? pass.startedAt) > new Date(tour.createdAt))
    return { kind: "failed", detail: pass.detail };
  return { kind: "ready", tour };
};

/** The tour pass among a change's passes, if one ever ran. */
export const tourPass = (passes: ReadonlyArray<ChangePassDto>): ChangePassDto | null =>
  passes.find((pass) => pass.kind === "tour") ?? null;

/**
 * Why the pass failed, in a person's words. The server records the error's own words; the ones a
 * person can act on are said plainly, and anything else is shown as it came.
 */
export const passFailureWords = (detail: string | null): string => {
  if (detail === null || detail.trim() === "") return "Try again.";
  if (/connected account|reconnect/i.test(detail)) {
    const harness = /\bcodex\b/i.test(detail) ? "codex" : "claude";
    const agent = harness === "codex" ? "Codex" : "Claude Code";
    return `Your ${agent} login needs connecting again. Run \`mend connect ${harness}\` on your computer, then try again.`;
  }
  if (/queued before Mend recorded who asked/i.test(detail))
    return "Mend didn't know whose agent login to use. Try again.";
  if (/never launched supervised|has no record/i.test(detail))
    return "The session left no record for Mend to read, so there is nothing to write it from.";
  if (/no contributing session/i.test(detail))
    return "No session has worked in this workspace, so there is no record to write it from.";
  if (/no stops/i.test(detail)) return "Mend found nothing in the change to walk you through.";
  const said = detail.trim();
  const sentence = said.charAt(0).toUpperCase() + said.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
};

/**
 * The texts whose sha256 is the digest of a tour written from exactly this patch. The tour's
 * digest is of the worktree's diff: the tracked files' diff first, then each untracked file's,
 * each without its last newline, joined by newlines. The review's patch is one `git diff` sorted
 * by path, so a change with new files the agent never added differs only in order. A new file the
 * agent did add sits with the tracked ones; a mix of both is read as out of date.
 */
export const tourDigestTexts = (patch: string): ReadonlyArray<string> => {
  const sections = patch
    .split(/(?=^diff --git )/m)
    .filter((section) => section !== "")
    .map((section) => section.replace(/\n$/, ""));
  const moved = [...sections.filter((section) => !isNew(section)), ...sections.filter(isNew)].join(
    "\n",
  );
  return moved === patch ? [patch] : [patch, moved];
};

/** Whether a file's section of a patch adds the file. */
const isNew = (section: string) => section.split("\n", 2)[1]?.startsWith("new file mode") ?? false;

/** Where a stop sits in the Change view. */
export type StopPlace =
  /** Under the Description: a stop with no file, or one whose file has left the change. */
  | { readonly kind: "change" }
  /** Under the file's header, with the bar on the header. */
  | { readonly kind: "file"; readonly path: string }
  /**
   * Between the file's rows: the note after `after` (a new-side line number, 0 for above the first
   * hunk), the bar on new-side lines `from` to `to`.
   */
  | {
      readonly kind: "line";
      readonly path: string;
      readonly after: number;
      readonly from: number;
      readonly to: number;
    };

/** The new-side lines a hunk shows, first and last; null when it shows none. */
const newSide = (hunk: { readonly newStart: number; readonly newLines: number }) =>
  hunk.newLines === 0 ? null : { first: hunk.newStart, last: hunk.newStart + hunk.newLines - 1 };

/**
 * Where a stop goes in this change. A stop's lines are new-file lines. When the first of them
 * isn't in the diff (a tour written before the change moved), the stop goes under its file's
 * header; when its file isn't in the change, under the Description.
 */
export const stopPlace = (stop: TourStopDto, files: ReadonlyArray<ChangeFile>): StopPlace => {
  if (stop.file === null) return { kind: "change" };
  const file = files.find((each) => each.path === stop.file);
  if (file === undefined) return { kind: "change" };
  if (stop.line === null) return { kind: "file", path: file.path };
  const line = stop.line;
  const shown = file.file.hunks.flatMap((hunk) => {
    const side = newSide(hunk);
    return side === null ? [] : [side];
  });
  const at = shown.findIndex((side) => line >= side.first && line <= side.last);
  const hunk = shown[at];
  if (hunk === undefined) return { kind: "file", path: file.path };
  const to = Math.max(line, Math.min(stop.endLine ?? line, hunk.last));
  // Directly above the stop's first line: after the line before it, or after the last line of
  // the hunk before, or above the first hunk.
  const after = line > hunk.first ? line - 1 : (shown[at - 1]?.last ?? 0);
  return { kind: "line", path: file.path, after, from: line, to };
};

/** A stop's place as the rail and the note name it: `retry.ts:25-29`, `charge.test.ts`. */
export const stopPlaceWords = (stop: TourStopDto): string => {
  if (stop.file === null) return "Whole change";
  const name = stop.file.slice(stop.file.lastIndexOf("/") + 1);
  if (stop.line === null) return name;
  return stop.endLine === null || stop.endLine === stop.line
    ? `${name}:${stop.line}`
    : `${name}:${stop.line}-${stop.endLine}`;
};

/** A run of narration: plain words, or code the model wrote between backticks. */
export interface NarrationPart {
  readonly code: boolean;
  readonly text: string;
  /** Where the run starts in the narration: a key for it. */
  readonly start: number;
}

/** Narration split into its words and its `code`. An unclosed backtick is read as a backtick. */
export const narrationParts = (text: string): ReadonlyArray<NarrationPart> => {
  const pieces = text.split("`");
  if (pieces.length % 2 === 0) return [{ code: false, text, start: 0 }];
  let start = 0;
  return pieces.flatMap((piece, index) => {
    const at = start;
    start += piece.length + 1;
    return piece === "" ? [] : [{ code: index % 2 === 1, text: piece, start: at }];
  });
};

/** The summary's paragraphs: Mend writes them separated by blank lines. */
export const paragraphs = (text: string): ReadonlyArray<string> =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

/**
 * The removed lines that sit between a stop's first and last lines, by their old-side numbers,
 * read from the file's patch: the bar runs through them too.
 */
export const removedWithin = (patch: string, from: number, to: number): ReadonlyArray<number> => {
  const removed: Array<number> = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const row of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
    } else if (!inHunk || row.startsWith("\\")) continue;
    else if (row.startsWith("-")) {
      // Between new lines newLine - 1 and newLine.
      if (newLine - 1 >= from && newLine <= to) removed.push(oldLine);
      oldLine += 1;
    } else if (row.startsWith("+")) newLine += 1;
    else if (row.startsWith(" ") || row === "") {
      oldLine += 1;
      newLine += 1;
    } else inHunk = false;
  }
  return removed;
};
