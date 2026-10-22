import { createHash } from "node:crypto";

import type { DiffFileFact } from "@mend/store";

export interface ParsedReviewHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly contextHash: string;
  readonly patch: string;
}

export interface ParsedReviewFile extends DiffFileFact {
  readonly patch: string;
  readonly hunks: ReadonlyArray<ParsedReviewHunk>;
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Digest the exact unified patch bytes returned to clients. */
export const digestReviewPatch = (patch: string): string => digest(patch);

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const parseHunks = (filePatch: string): ReadonlyArray<ParsedReviewHunk> => {
  const lines = filePatch.split("\n");
  const starts = lines.flatMap((line, index) => (hunkHeader.test(line) ? [index] : []));
  return starts.flatMap((start, index) => {
    const header = lines[start] ?? "";
    const match = hunkHeader.exec(header);
    if (match === null) return [];
    const end = starts[index + 1] ?? lines.length;
    const patchLines = lines.slice(start, end);
    const context = patchLines.filter((line, lineIndex) => lineIndex === 0 || line.startsWith(" "));
    return [
      {
        header,
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? "1"),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? "1"),
        contextHash: digest(context.join("\n")),
        patch: patchLines.join("\n"),
      },
    ];
  });
};

/** Pair git's authoritative name/status facts with the corresponding unified-patch sections. */
export const parseReviewDiff = (
  patch: string,
  facts: ReadonlyArray<DiffFileFact>,
): ReadonlyArray<ParsedReviewFile> => {
  const sections = patch
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  const groupedSections: Array<{ readonly header: string; patch: string }> = [];
  for (const section of sections) {
    const header = section.split("\n", 1)[0] ?? "";
    const previous = groupedSections.at(-1);
    if (previous?.header === header) {
      previous.patch += section;
    } else {
      groupedSections.push({ header, patch: section });
    }
  }
  return facts.map((fact, index) => {
    const filePatch = groupedSections[index]?.patch ?? "";
    return { ...fact, patch: filePatch, hunks: parseHunks(filePatch) };
  });
};
