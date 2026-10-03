/**
 * Merging two versions of an agent memory file without losing either side's lines
 * (docs/adr/0009, decisions 3 and 4). Pure text work: the three-way merge against a shared version
 * is `git merge-file --union`, which the server supplies; everything here needs no shared version.
 *
 * - `unionLines`: both sides' lines, each shared line once, in place. Between two shared lines the
 *   first side's own lines come first, then the second side's: the order `git merge-file --union`
 *   gives a conflict, so a merge with and without a shared version reads the same. Files too
 *   different to align are not merged at all (null): the caller keeps both whole.
 * - Frontmatter (`---` … `---` at the top of a Claude topic file) is merged key by key, never by
 *   line: a line union would write a key twice. Only a simple subset is merged by key (`key: value`
 *   lines and whole-line comments); any other YAML that differs is not merged (null).
 * - An index (`MEMORY.md`) keeps each index entry (`- [Title](file.md) …`) once.
 * - `missingLines` says whether a merge kept every line of the incoming side.
 */

interface Lines {
  readonly lines: ReadonlyArray<string>;
  readonly trailingNewline: boolean;
}

const linesOf = (text: string): Lines => {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  return { lines: (trailingNewline ? text.slice(0, -1) : text).split("\n"), trailingNewline };
};

const textOf = (lines: ReadonlyArray<string>, trailingNewline: boolean): string =>
  lines.length === 0 ? "" : `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;

/** Beyond this many cells the alignment table is not built: 16 MB of it. */
const ALIGN_MAX_CELLS = 4_000_000;

/**
 * The index pairs of a longest common subsequence of `a` and `b`, in order; null when the part
 * that differs is too large to align. A shared start and end are matched without the table.
 */
const commonLines = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<readonly [number, number]> | null => {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const pairs: Array<readonly [number, number]> = [];
  for (let k = 0; k < start; k += 1) pairs.push([k, k]);
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0) {
    if (n * m > ALIGN_MAX_CELLS) return null;
    const width = m + 1;
    // table[i * width + j]: the common length of a[start + i ..] and b[start + j ..].
    const table = new Uint32Array((n + 1) * width);
    const at = (i: number, j: number) => table[i * width + j] ?? 0;
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? at(i + 1, j + 1) + 1
            : Math.max(at(i + 1, j), at(i, j + 1));
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i += 1;
        j += 1;
      } else if (at(i + 1, j) >= at(i, j + 1)) i += 1;
      else j += 1;
    }
  }
  for (let k = 0; k < a.length - endA; k += 1) pairs.push([endA + k, endB + k]);
  return pairs;
};

/**
 * Both versions' lines with no shared version to diff against: each line the two share once, in
 * place, and between two shared lines `ours`' own lines, then `theirs`'. Null when the parts that
 * differ are too large to align (over `ALIGN_MAX_CELLS`): no line is ever dropped to merge them.
 */
export const unionLines = (ours: string, theirs: string): string | null => {
  const o = linesOf(ours);
  const t = linesOf(theirs);
  if (t.lines.length === 0) return ours;
  if (o.lines.length === 0) return theirs;
  const pairs = commonLines(o.lines, t.lines);
  if (pairs === null) return null;
  const out: Array<string> = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [o.lines.length, t.lines.length] as const]) {
    out.push(...o.lines.slice(i, pi), ...t.lines.slice(j, pj));
    const shared = o.lines[pi];
    if (shared !== undefined) out.push(shared);
    i = pi + 1;
    j = pj + 1;
  }
  return textOf(out, o.trailingNewline || t.trailingNewline);
};

/** Claude's `MEMORY.md` (and Codex's): an index, one line per memory. */
export const isAgentMemoryIndex = (filePath: string): boolean =>
  filePath === "MEMORY.md" || filePath.endsWith("/MEMORY.md");

/** One index entry: a list item that opens with a link, `- [Title](file.md) — hook`. */
const INDEX_ENTRY = /^\s*[-*+]\s+\[[^\]]*\]\([^)\s]+\)/;
/** A Markdown code fence: everything between two of them is code, never an entry. */
const FENCE = /^\s*(```|~~~)/;

/**
 * Each index entry once, at its first place: what an index merge leaves. Only entry lines outside
 * code fences are compared; every other line (headings, blank lines, fences, delimiters, prose)
 * stays as it is, however often it repeats.
 */
export const withoutRepeatedEntries = (text: string): string => {
  const { lines, trailingNewline } = linesOf(text);
  const seen = new Set<string>();
  let fenced = false;
  const kept = lines.filter((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return true;
    }
    if (fenced || !INDEX_ENTRY.test(line)) return true;
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
  return textOf(kept, trailingNewline);
};

export interface Frontmatter {
  /** The lines between the opening and closing `---`. */
  readonly lines: ReadonlyArray<string>;
  /** Everything after the closing `---` line. */
  readonly body: string;
}

/** A file's YAML frontmatter and body, or null when it does not open with `---`. LF only. */
export const splitFrontmatter = (text: string): Frontmatter | null => {
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---\n", 3);
  const end = close !== -1 ? close : text.endsWith("\n---") ? text.length - 4 : -1;
  if (end === -1) return null;
  const inner = end <= 4 ? "" : text.slice(4, end);
  return { lines: inner === "" ? [] : inner.split("\n"), body: text.slice(end + 5) };
};

export const joinFrontmatter = (frontmatter: Frontmatter): string =>
  `---\n${frontmatter.lines.map((line) => `${line}\n`).join("")}---\n${frontmatter.body}`;

/**
 * A `key: value` line the key merge understands: a plain key and a one-line value. A quoted key,
 * an empty value (a nested map or list follows) and a block scalar (`|`, `>`) are outside it.
 */
const SIMPLE_ENTRY =
  /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(?:[ \t]+(?![|>][-+0-9]*[ \t]*(?:#.*)?$)\S.*)$/;
const COMMENT = /^#/;

/**
 * Frontmatter as keyed entries, when it lies in the subset the key merge understands: each line a
 * `key: value` (`SIMPLE_ENTRY`), a whole-line comment, or blank; no key twice. A comment or blank
 * line belongs to the entry above it and is part of its content; lines before the first key are an
 * entry keyed "". Null for anything else, which is not merged by key.
 */
const entriesOf = (
  lines: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<string>> | null => {
  const entries = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const line of lines) {
    const key = SIMPLE_ENTRY.exec(line)?.[1];
    if (key !== undefined) {
      if (entries.has(key)) return null;
      current = [line];
      entries.set(key, current);
    } else if (COMMENT.test(line) || line.trim() === "") {
      if (current === undefined) {
        current = [];
        entries.set("", current);
      }
      current.push(line);
    } else return null;
  }
  return entries;
};

const same = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.join("\n") === b.join("\n"));

/**
 * Two frontmatters merged key by key, against `base` when there is one; null when any of them lies
 * outside the subset `entriesOf` understands and they differ. An entry is its key line with the
 * comments under it, all compared as content. An entry one side changed since `base` takes that
 * side's; one both set differently keeps `ours` and adds each line of `theirs` it lacks, a key
 * line as a comment (`# <note>: key: value`), a comment as it is. Keys keep `ours`' order, then
 * `theirs`' new ones.
 */
export const mergeFrontmatterLines = (input: {
  readonly ours: ReadonlyArray<string>;
  readonly theirs: ReadonlyArray<string>;
  readonly base: ReadonlyArray<string> | null;
  /** Who `theirs` came from, for the comment: `from laptop, 2026-10-04`. */
  readonly note: string;
}): ReadonlyArray<string> | null => {
  if (same(input.ours, input.theirs)) return input.ours;
  if (input.base !== null && same(input.theirs, input.base)) return input.ours;
  if (input.base !== null && same(input.ours, input.base)) return input.theirs;
  const ours = entriesOf(input.ours);
  const theirs = entriesOf(input.theirs);
  const base = input.base === null ? null : entriesOf(input.base);
  if (ours === null || theirs === null || (input.base !== null && base === null)) return null;
  const keys = [...ours.keys(), ...[...theirs.keys()].filter((key) => !ours.has(key))];
  const out: Array<string> = [];
  for (const key of keys) {
    const s = ours.get(key);
    const t = theirs.get(key);
    const b = base?.get(key);
    const unchangedSince = (entry: ReadonlyArray<string> | undefined) =>
      base !== null && same(entry, b);
    if (t === undefined) {
      // Theirs lacks it: removed there when ours still holds it as it was, else ours stands.
      if (s !== undefined && !unchangedSince(s)) out.push(...s);
      continue;
    }
    if (s === undefined) {
      if (!unchangedSince(t)) out.push(...t);
      continue;
    }
    if (same(s, t) || unchangedSince(t)) {
      out.push(...s);
      continue;
    }
    if (unchangedSince(s)) {
      out.push(...t);
      continue;
    }
    const added = t
      .filter((line) => line.trim() !== "" && !s.includes(line))
      .map((line) => (COMMENT.test(line) ? line : `# ${input.note}: ${line}`))
      .filter((line) => !s.includes(line));
    out.push(...s, ...added);
  }
  return out;
};

/** A line a merge noted rather than kept: `# from <who>, <yyyy-mm-dd>: <line>`. */
const NOTED = /^# from .+?, \d{4}-\d{2}-\d{2}: (.*)$/;

const counts = (lines: ReadonlyArray<string>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const line of lines) out.set(line, (out.get(line) ?? 0) + 1);
  return out;
};

/**
 * The non-blank lines of `theirs` that `merged` does not hold, counted: as they are, or noted by a
 * frontmatter merge. With a `base`, a line `ours` removed since it is not missing: a three-way
 * merge drops it on purpose. In an index, an entry only has to be there once.
 */
export const missingLines = (input: {
  readonly path: string;
  readonly merged: string;
  readonly theirs: string;
  readonly ours: string;
  readonly base: string | null;
}): ReadonlyArray<string> => {
  const mergedLines = linesOf(input.merged).lines;
  const have = counts([
    ...mergedLines,
    ...mergedLines.flatMap((line) => {
      const noted = NOTED.exec(line)?.[1];
      return noted === undefined ? [] : [noted];
    }),
  ]);
  const ours = counts(linesOf(input.ours).lines);
  const base = input.base === null ? new Map<string, number>() : counts(linesOf(input.base).lines);
  const index = isAgentMemoryIndex(input.path);
  const missing: Array<string> = [];
  for (const [line, count] of counts(linesOf(input.theirs).lines)) {
    if (line.trim() === "") continue;
    const removedByOurs = Math.max(0, (base.get(line) ?? 0) - (ours.get(line) ?? 0));
    const needed = Math.max(0, (index && INDEX_ENTRY.test(line) ? 1 : count) - removedByOurs);
    if ((have.get(line) ?? 0) < needed) missing.push(line);
  }
  return missing;
};
