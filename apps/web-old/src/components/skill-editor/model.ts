import { SKILL_ENTRY_FILE, validateSkillFilePath } from "@mend/domain/workbench";

/** One file of a skill as the editor holds it. */
export interface DraftFile {
  readonly path: string;
  readonly contents: string;
}

/** "38 KB", "512 B", "1.4 MB": a skill's size as the lists say it. */
export const skillSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** "6 files · 38 KB". */
export const skillShape = (skill: { readonly fileCount: number; readonly bytes: number }) =>
  `${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"} · ${skillSize(skill.bytes)}`;

/** "Oct 31", with the year when it is not this one. */
export const skillDate = (date: Date, now: Date = new Date()): string =>
  date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });

/** How many files the draft changed against what was saved: edited, added and removed. */
export const changedFiles = (
  saved: ReadonlyArray<DraftFile>,
  draft: ReadonlyArray<DraftFile>,
): number => {
  const before = new Map(saved.map((file) => [file.path, file.contents]));
  const after = new Map(draft.map((file) => [file.path, file.contents]));
  let count = 0;
  for (const [path, contents] of after) if (before.get(path) !== contents) count += 1;
  for (const path of before.keys()) if (!after.has(path)) count += 1;
  return count;
};

/** Why a new file's path cannot be added, or null when it can. */
export const newFileIssue = (path: string, draft: ReadonlyArray<DraftFile>): string | null => {
  const issue = validateSkillFilePath(path);
  if (issue !== null) return issue;
  return draft.some((file) => file.path === path) ? `${path} is already in this skill` : null;
};

/** `SKILL.md` first, then the rest in path order, as the file list shows them. */
export const orderedFiles = <F extends DraftFile>(files: ReadonlyArray<F>): ReadonlyArray<F> =>
  files.toSorted((a, b) =>
    a.path === SKILL_ENTRY_FILE
      ? -1
      : b.path === SKILL_ENTRY_FILE
        ? 1
        : a.path.localeCompare(b.path),
  );

/** The starting `SKILL.md` of a blank skill. */
export const blankSkillFile = (name: string): string => `---
name: ${name}
description: One line saying when an agent should reach for this.
---

Instructions the agent loads when the skill applies.
`;

/** A block of a skill's markdown, for the read-only preview. */
export type PreviewBlock =
  | { readonly kind: "facts"; readonly rows: ReadonlyArray<readonly [string, string]> }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: ReadonlyArray<string> }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string };

const LIST_ITEM = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

/**
 * The few markdown shapes a skill uses, as blocks: its front matter as facts, headings, lists,
 * fenced code and paragraphs. Everything else reads as a paragraph of its own words; nothing is
 * rendered as HTML.
 */
export const previewBlocks = (source: string): ReadonlyArray<PreviewBlock> => {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<PreviewBlock> = [];
  let index = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
    if (end > 0) {
      const rows = lines.slice(1, end).flatMap((line): Array<readonly [string, string]> => {
        const colon = line.indexOf(":");
        return colon <= 0 ? [] : [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()]];
      });
      if (rows.length > 0) blocks.push({ kind: "facts", rows });
      index = end + 1;
    }
  }
  let paragraph: Array<string> = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith("```")) {
      flush();
      const body: Array<string> = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      const hashes = heading[1]?.length ?? 1;
      blocks.push({
        kind: "heading",
        level: hashes === 1 ? 1 : hashes === 2 ? 2 : 3,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flush();
      const ordered = item[1] !== undefined;
      const items: Array<string> = [];
      while (index < lines.length) {
        const next = LIST_ITEM.exec(lines[index] ?? "");
        if (next === null || (next[1] !== undefined) !== ordered) break;
        items.push(next[2] ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return blocks;
};
