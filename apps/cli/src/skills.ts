import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Local skill-library scanning for `mend skills push`. Runs on the machine
 * that HAS the skills: the shared agent-skills convention keeps them under
 * `~/.agents/skills/<name>/SKILL.md` (plus support files), and the CLI
 * captures the bundles here and streams them to the server's library. The
 * CLI stays dependency-light by design, so the frontmatter peek below is a
 * few lines of string handling, not a YAML parser — the server re-validates
 * everything.
 */

/** Where the shared convention keeps user skills, relative to `$HOME`. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

/** The servers' caps, checked here so a mistake fails before the upload. */
export const MAX_SKILL_FILES = 64;
export const MAX_SKILL_FILE_BYTES = 512 * 1024;

export interface ScannedSkill {
  readonly name: string;
  readonly description: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
  readonly bytes: number;
}

/** Something the scan left behind, worth a line in the output — never fatal. */
export interface SkillScanNote {
  readonly skill: string;
  readonly message: string;
}

const IGNORED_DIRS = new Set([".git", "node_modules", "__pycache__"]);

const isTextBuffer = (buffer: Buffer): boolean => !buffer.subarray(0, 8192).includes(0);

/**
 * Pull `description:` out of a SKILL.md frontmatter block. Single-line plain
 * or quoted scalars only — the common case by far; anything else reads as
 * absent and the server keeps an empty description.
 */
export const readFrontmatterDescription = (contents: string): string => {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) return "";
  const end = contents.indexOf("\n---", 3);
  if (end === -1) return "";
  for (const line of contents.slice(0, end).split("\n")) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const raw = (match[1] ?? "").trim();
    if (raw === "" || raw === "|" || raw === ">" || raw === "|-" || raw === ">-") return "";
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    return quoted?.[2] ?? raw;
  }
  return "";
};

const walkFiles = (root: string, onCycle: (directory: string) => void): ReadonlyArray<string> => {
  const found: string[] = [];
  const ancestors = new Set<string>();
  const visit = (dir: string) => {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch (cause) {
      // A directory link can disappear after stat, or its target can itself be a link loop.
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR" || cause.code === "ELOOP")
      )
        return;
      throw cause;
    }
    if (ancestors.has(realDir)) {
      onCycle(dir);
      return;
    }
    // Track only this path's ancestors so distinct resource aliases retain their bundle paths.
    ancestors.add(realDir);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        // stat (not the dirent) so symlinked files and directories both count.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absolute);
        } catch {
          continue; // dangling symlink
        }
        if (stat.isDirectory()) visit(absolute);
        else if (stat.isFile()) found.push(absolute);
      }
    } finally {
      ancestors.delete(realDir);
    }
  };
  visit(root);
  return found.toSorted();
};

/**
 * Scan a skill library directory: every immediate subdirectory carrying a
 * `SKILL.md` becomes one bundle. Oversized and binary files are skipped with
 * a note; a directory without a SKILL.md is noted and left out entirely.
 * Directory symlink cycles are noted and skipped; other resource aliases keep their bundle paths.
 */
export const scanSkillLibrary = (
  root: string,
):
  | { readonly skills: ReadonlyArray<ScannedSkill>; readonly notes: ReadonlyArray<SkillScanNote> }
  | { readonly error: string } => {
  let entries: ReadonlyArray<fs.Dirent>;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { error: `${root} is not a readable directory` };
  }
  const skills: ScannedSkill[] = [];
  const notes: SkillScanNote[] = [];
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const skillDir = path.join(root, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(skillDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
      notes.push({ skill: entry.name, message: "no SKILL.md — skipped" });
      continue;
    }
    const files: Array<{ readonly path: string; readonly contents: string }> = [];
    let bytes = 0;
    for (const absolute of walkFiles(skillDir, (directory) => {
      const relative = path.relative(skillDir, directory).split(path.sep).join("/");
      notes.push({
        skill: entry.name,
        message: `${relative} points to an ancestor directory — skipped`,
      });
    })) {
      const relative = path.relative(skillDir, absolute).split(path.sep).join("/");
      const buffer = fs.readFileSync(absolute);
      if (buffer.byteLength > MAX_SKILL_FILE_BYTES) {
        notes.push({ skill: entry.name, message: `${relative} is over 512KB — skipped` });
        continue;
      }
      if (!isTextBuffer(buffer)) {
        notes.push({ skill: entry.name, message: `${relative} is binary — skipped` });
        continue;
      }
      files.push({ path: relative, contents: buffer.toString("utf8") });
      bytes += buffer.byteLength;
    }
    if (files.length > MAX_SKILL_FILES) {
      notes.push({
        skill: entry.name,
        message: `${files.length} files is over the ${MAX_SKILL_FILES}-file cap — skipped`,
      });
      continue;
    }
    const entryFile = files.find((file) => file.path === "SKILL.md");
    if (entryFile === undefined) {
      notes.push({ skill: entry.name, message: "SKILL.md was unreadable — skipped" });
      continue;
    }
    skills.push({
      name: entry.name.toLowerCase(),
      description: readFrontmatterDescription(entryFile.contents),
      files,
      bytes,
    });
  }
  return { skills, notes };
};
