import {
  SKILL_ENTRY_FILE,
  SKILL_MAX_BYTES,
  SKILL_MAX_DESCRIPTION_LENGTH,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_NAME_LENGTH,
  skillBundleBytes,
  validateSkillFilePath,
  validateSkillName,
} from "@mend/domain/workbench";

import type { SkillSearch } from "./skill-search.ts";

/**
 * The rules and words of the Skills pages (`/skills`, `/skills/<id>`), kept apart from the
 * components so each can be tested alone. Copied from the old app's `components/skills/model.ts`
 * and `components/skill-editor/model.ts`, with what the new pages add: search, each field's own
 * error, the front matter New skill fills in, and the lines that say when a skill changed and where
 * it is used.
 */

/** One file of a skill as the editor holds it. */
export interface DraftFile {
  readonly path: string;
  readonly contents: string;
}

/** A skill as the list and the panel read it. */
export interface SkillFacts {
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly updatedAt: Date;
}

// ─── Sizes ──────────────────────────────────────────────────────────────────

/** "38 KB", "512 B", "1.4 MB": a skill's size as the pages say it. */
export const skillSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** "SKILL.md, 1 KB" or "3 files, 38 KB": what Remove skill… says it removes. */
export const skillFilesLine = (skill: {
  readonly fileCount: number;
  readonly bytes: number;
}): string =>
  `${skill.fileCount === 1 ? SKILL_ENTRY_FILE : `${skill.fileCount} files`}, ${skillSize(skill.bytes)}`;

// ─── A draft against what was saved ─────────────────────────────────────────

/** The paths a draft changed against what was saved: edited, added or removed, once each. */
export const changedFiles = (
  saved: ReadonlyArray<DraftFile>,
  draft: ReadonlyArray<DraftFile>,
): ReadonlyArray<string> => {
  const before = new Map(saved.map((file) => [file.path, file.contents]));
  const after = new Map(draft.map((file) => [file.path, file.contents]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
};

/** The mark beside a file in the editor's list: `new`, `edited`, or none. */
export const fileMark = (
  saved: ReadonlyArray<DraftFile>,
  file: DraftFile,
): "new" | "edited" | null => {
  const before = saved.find((entry) => entry.path === file.path);
  if (before === undefined) return "new";
  return before.contents === file.contents ? null : "edited";
};

/** "2 files changed, not saved", "Description changed, not saved", or "No changes". */
export const unsavedWords = (files: number, descriptionChanged: boolean): string => {
  if (files === 0) return descriptionChanged ? "Description changed, not saved" : "No changes";
  const count = `${files} file${files === 1 ? "" : "s"} changed`;
  return `${count}${descriptionChanged ? " and the description" : ""}, not saved`;
};

/** What Leave without saving? says was changed: "2 files", "the description", or both. */
export const changedWhat = (files: number, descriptionChanged: boolean): string => {
  const count = files === 0 ? null : `${files} file${files === 1 ? "" : "s"}`;
  if (count === null) return "the description";
  return descriptionChanged ? `${count} and the description` : count;
};

/**
 * Which lines of `after` differ from `before`: everything between their longest common prefix
 * and longest common suffix. One inserted line marks that line alone, not every line after it.
 */
export const changedLines = (before: string, after: string): ReadonlySet<number> => {
  const old = before.split("\n");
  const now = after.split("\n");
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start += 1;
  let endOld = old.length - 1;
  let endNow = now.length - 1;
  while (endOld >= start && endNow >= start && old[endOld] === now[endNow]) {
    endOld -= 1;
    endNow -= 1;
  }
  const marked = new Set<number>();
  for (let line = start; line <= endNow; line += 1) marked.add(line);
  return marked;
};

/** "3 lines changed", or nothing when none did. */
export const changedLinesWords = (count: number): string =>
  count === 0 ? "" : `${count} line${count === 1 ? "" : "s"} changed`;

/** `SKILL.md` first, then the rest in path order, as the file lists show them. */
export const orderedFiles = <F extends DraftFile>(files: ReadonlyArray<F>): ReadonlyArray<F> =>
  files.toSorted((a, b) =>
    a.path === SKILL_ENTRY_FILE
      ? -1
      : b.path === SKILL_ENTRY_FILE
        ? 1
        : a.path.localeCompare(b.path),
  );

/** The file a page shows: the one named in the URL when the skill has it, else SKILL.md. */
export const shownFile = <F extends DraftFile>(
  files: ReadonlyArray<F>,
  requested: string | undefined,
): F | undefined =>
  files.find((file) => file.path === requested) ??
  files.find((file) => file.path === SKILL_ENTRY_FILE) ??
  files[0];

// ─── Each field's rule, in a person's words ─────────────────────────────────

const count = (value: number) => value.toLocaleString("en-US");
const bytesOf = (value: string) => new TextEncoder().encode(value).length;

/**
 * Why a name can't be used, or null. The domain's rule decides (`validateSkillName`); these are its
 * words for a person, and the one rule the server checks only on save: a name already in the list,
 * yours or, given its name, a project's.
 */
export const nameIssue = (
  name: string,
  taken: ReadonlyArray<string>,
  projectName: string | null = null,
): string | null => {
  if (validateSkillName(name) === null) {
    if (!taken.includes(name)) return null;
    return projectName === null
      ? `You already have a skill named ${name}. Pick another name.`
      : `${projectName} already has a skill named ${name}. Pick another name.`;
  }
  if (name === "") return "Give the skill a name.";
  if (name.length > SKILL_MAX_NAME_LENGTH) {
    return `A name can be ${SKILL_MAX_NAME_LENGTH} characters at most. This one has ${count(name.length)}.`;
  }
  return /^[a-z0-9]/.test(name)
    ? "Use only lowercase letters, digits, dots, dashes and underscores."
    : "Start the name with a lowercase letter or a digit.";
};

/** Why a description can't be saved, or null. */
export const descriptionIssue = (description: string): string | null =>
  description.length > SKILL_MAX_DESCRIPTION_LENGTH
    ? `A description can be ${count(SKILL_MAX_DESCRIPTION_LENGTH)} characters at most. This one has ${count(description.length)}.`
    : null;

/** Why a file is too big to save, or null. */
export const fileIssue = (file: DraftFile): string | null => {
  const bytes = bytesOf(file.contents);
  return bytes > SKILL_MAX_FILE_BYTES
    ? `${file.path} is ${skillSize(bytes)}. A file in a skill can be ${skillSize(SKILL_MAX_FILE_BYTES)} at most, so trim it.`
    : null;
};

/** Why the skill as a whole can't be saved, or null: too many files, or too big in all. */
export const bundleIssue = (files: ReadonlyArray<DraftFile>): string | null => {
  if (files.length > SKILL_MAX_FILES) {
    return `This skill has ${files.length} files. A skill can have ${SKILL_MAX_FILES} at most.`;
  }
  const total = skillBundleBytes(files);
  return total > SKILL_MAX_BYTES
    ? `This skill is ${skillSize(total)} in all. A skill can be ${SKILL_MAX_BYTES / (1024 * 1024)} MB at most, so trim a file.`
    : null;
};

/** Why a new file's path can't be added, or null when it can. */
export const newFileIssue = (path: string, draft: ReadonlyArray<DraftFile>): string | null => {
  if (draft.some((file) => file.path === path)) return `${path} is already in this skill.`;
  if (draft.length >= SKILL_MAX_FILES) {
    return `A skill can have ${SKILL_MAX_FILES} files at most.`;
  }
  if (validateSkillFilePath(path) === null) return null;
  if (path === "") return "Type a path, such as references/notes.md.";
  if (path.length > 256) return "A path can be 256 characters at most.";
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return "Use a path inside the skill, with forward slashes, such as references/notes.md.";
  }
  return 'A path can\'t have empty, "." or ".." parts.';
};

// ─── New skill's SKILL.md ───────────────────────────────────────────────────

/** A front matter value as YAML reads it: plain when it can be, else double-quoted. */
const yamlValue = (value: string): string =>
  value === "" || /^[\p{L}\p{N}][^:#\n"]*$/u.test(value) ? value : JSON.stringify(value);

const FRONT_MATTER = /^---\n([\s\S]*?)\n---(\n|$)/;

/**
 * The SKILL.md with its front matter's `name` and `description` set from New skill's fields: each
 * line replaced where it is, added when missing, and the front matter added when the file has
 * none. Everything else in the file stays as the person typed it.
 */
export const withFrontMatter = (contents: string, name: string, description: string): string => {
  const lines = {
    name: `name: ${yamlValue(name)}`,
    description: `description: ${yamlValue(description)}`,
  };
  const match = FRONT_MATTER.exec(contents);
  if (match === null) return `---\n${lines.name}\n${lines.description}\n---\n\n${contents}`;
  const body = (match[1] ?? "").split("\n");
  for (const key of ["name", "description"] as const) {
    const at = body.findIndex((line) => line.startsWith(`${key}:`));
    if (at === -1) body.push(lines[key]);
    else body[at] = lines[key];
  }
  return `---\n${body.join("\n")}\n---${match[2] ?? ""}${contents.slice(match[0].length)}`;
};

/** The SKILL.md New skill starts from. */
export const BLANK_SKILL_FILE = withFrontMatter(
  "# Title\n\nWhat the agent should do when this skill applies.\n",
  "",
  "",
);

// ─── Search ─────────────────────────────────────────────────────────────────

/** Whether a skill matches what was typed in Search: its name or description holds the words. */
export const matchesSearch = (skill: Pick<SkillFacts, "name" | "description">, query: string) => {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    skill.name.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  );
};

/** A text cut where it matches the search, so each match can be marked. */
export const highlighted = (
  text: string,
  query: string,
): ReadonlyArray<{ readonly start: number; readonly text: string; readonly match: boolean }> => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [{ start: 0, text, match: false }];
  const parts: Array<{ start: number; text: string; match: boolean }> = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ start: from, text: text.slice(from, at), match: false });
    parts.push({ start: at, text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ start: from, text: text.slice(from), match: false });
  return parts;
};

/** The words beside "Your skills": the count, or how many match the search. */
export const listCountWords = (shown: number, total: number, query: string): string => {
  const needle = query.trim();
  if (needle === "") return String(total);
  return `${shown === 0 ? "none" : shown} of ${total} match "${needle}"`;
};

// ─── When it changed ────────────────────────────────────────────────────────

const JUST_NOW_MS = 60_000;

/** "12 Nov", with the year when it is not this one; "just now" within the last minute. */
export const skillDay = (at: Date, now: Date): string => {
  if (now.getTime() - at.getTime() < JUST_NOW_MS) return "just now";
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
};

/** A list row's right-hand words: "Created just now", "Edited 12 Nov". */
export const rowWhen = (skill: SkillFacts, now: Date): string =>
  `${skill.revision === 1 ? "Created" : "Edited"} ${skillDay(skill.updatedAt, now)}`;

/** Whether the skill was saved over an earlier revision in the last minute. */
export const justSaved = (skill: SkillFacts, now: Date): boolean =>
  skill.revision > 1 && now.getTime() - skill.updatedAt.getTime() < JUST_NOW_MS;

/** When the skill last changed, as the person did it: "You edited it on 12 Nov." */
export const whenWords = (skill: SkillFacts, now: Date): string => {
  if (justSaved(skill, now)) return "You saved it just now.";
  const day = skillDay(skill.updatedAt, now);
  const on = day === "just now" ? day : `on ${day}`;
  return `You ${skill.revision === 1 ? "created" : "edited"} it ${on}.`;
};

/**
 * The first line under a skill's name: whose it is and when it last changed. Right after a save it
 * names the revision, as the saved state does.
 */
export const panelWhen = (skill: SkillFacts, now: Date): string =>
  justSaved(skill, now)
    ? `Your skill, revision ${skill.revision}. ${whenWords(skill, now)}`
    : `Your skill. ${whenWords(skill, now)}`;

// ─── Where it is used ───────────────────────────────────────────────────────

/** A project that has its own skill with the same name as one of yours. */
export interface ProjectTwin {
  readonly projectId: string;
  readonly projectName: string;
  readonly skillId: string;
}

/**
 * For each of your skills by name, the projects with a skill of the same name. A project skill
 * wins over yours with the same name, so in those projects yours is not used.
 */
export const projectTwins = (
  yours: ReadonlyArray<{ readonly name: string }>,
  projects: ReadonlyArray<{
    readonly projectId: string;
    readonly projectName: string;
    readonly skills: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  }>,
): ReadonlyMap<string, ReadonlyArray<ProjectTwin>> => {
  const twins = new Map<string, Array<ProjectTwin>>();
  for (const skill of yours) {
    const found = projects.flatMap((project) =>
      project.skills
        .filter((entry) => entry.name === skill.name)
        .map((entry) => ({
          projectId: project.projectId,
          projectName: project.projectName,
          skillId: entry.id,
        })),
    );
    if (found.length > 0) twins.set(skill.name, found);
  }
  return twins;
};

const listed = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;

/** A list row's words for a skill a project has its own of: "checkout-api uses its own". */
export const twinRowWords = (twins: ReadonlyArray<ProjectTwin>): string =>
  twins.length === 1
    ? `${twins[0]?.projectName ?? ""} uses its own`
    : `${twins.length} projects use their own`;

/** The panel's second line: where the skill goes, and where a project's own is used instead. */
export const usedInWords = (name: string, twins: ReadonlyArray<ProjectTwin>): string => {
  if (twins.length === 0) return "Used in every session you start.";
  const names = twins.map((twin) => twin.projectName);
  return twins.length === 1
    ? `Used in every session you start, except in ${names[0]}: ${names[0]} has its own ${name}, and its sessions use that one.`
    : `Used in every session you start, except in ${listed(names)}: each has its own ${name}, and their sessions use that one.`;
};

/** What the panel says after a save: which sessions get this revision. */
export const savedUseWords = (revision: number): string =>
  `New sessions get this version. Sessions that already started keep revision ${revision - 1}.`;

// ─── The read-only preview ──────────────────────────────────────────────────

/** A block of a skill's markdown, for the editor's Preview; `start` is the line it starts on. */
export type PreviewBlock = { readonly start: number } & (
  | { readonly kind: "facts"; readonly rows: ReadonlyArray<readonly [string, string]> }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: ReadonlyArray<{ readonly start: number; readonly text: string }>;
    }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
);

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
      if (rows.length > 0) blocks.push({ start: 0, kind: "facts", rows });
      index = end + 1;
    }
  }
  let paragraph: Array<string> = [];
  let paragraphStart = 0;
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ start: paragraphStart, kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith("```")) {
      flush();
      const start = index;
      const body: Array<string> = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ start, kind: "code", text: body.join("\n") });
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      const hashes = heading[1]?.length ?? 1;
      blocks.push({
        start: index,
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
      const start = index;
      const ordered = item[1] !== undefined;
      const items: Array<{ start: number; text: string }> = [];
      while (index < lines.length) {
        const next = LIST_ITEM.exec(lines[index] ?? "");
        if (next === null || (next[1] !== undefined) !== ordered) break;
        items.push({ start: index, text: next[2] ?? "" });
        index += 1;
      }
      blocks.push({ start, kind: "list", ordered, items });
      continue;
    }
    if (line.trim() === "") flush();
    else {
      if (paragraph.length === 0) paragraphStart = index;
      paragraph.push(line.trim());
    }
    index += 1;
  }
  flush();
  return blocks;
};

// ─── The URL ────────────────────────────────────────────────────────────────

/** The search for a file of a skill: SKILL.md needs none. */
export const fileSearch = (file: string | undefined, edit: boolean): SkillSearch => ({
  ...(file === undefined || file === SKILL_ENTRY_FILE ? {} : { file }),
  ...(edit ? { edit: 1 } : {}),
});
