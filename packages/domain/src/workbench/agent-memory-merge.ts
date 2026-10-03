/**
 * Merging two versions of an agent memory file without losing either side's lines
 * (docs/adr/0009, decisions 3 and 4). Pure text work: the three-way merge against a shared version
 * is `git merge-file --union`, which the server supplies; everything here needs no shared version.
 *
 * - `unionLines`: both sides' lines, each shared line once, in place. Between two shared lines the
 *   first side's own lines come first, then the second side's: the order `git merge-file --union`
 *   gives a conflict, so a merge with and without a shared version reads the same.
 * - Frontmatter (`---` … `---` at the top of a Claude topic file) is merged key by key, never by
 *   line: a line union would write a key twice. When both sides set a key to different values, the
 *   first side's stays and the second's is kept under it as a YAML comment, which no parser reads
 *   and the agent does.
 * - An index (`MEMORY.md`, one line per memory) keeps each line once.
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
 * place, and between two shared lines `ours`' own lines, then `theirs`'. A file too large to align
 * keeps `ours` whole, then each non-blank line of `theirs` that `ours` lacks.
 */
export const unionLines = (ours: string, theirs: string): string => {
  const o = linesOf(ours);
  const t = linesOf(theirs);
  if (t.lines.length === 0) return ours;
  if (o.lines.length === 0) return theirs;
  const pairs = commonLines(o.lines, t.lines);
  const out: Array<string> = [];
  if (pairs === null) {
    const have = new Set(o.lines);
    out.push(...o.lines, ...t.lines.filter((line) => line.trim() !== "" && !have.has(line)));
  } else {
    let i = 0;
    let j = 0;
    for (const [pi, pj] of [...pairs, [o.lines.length, t.lines.length] as const]) {
      out.push(...o.lines.slice(i, pi), ...t.lines.slice(j, pj));
      const shared = o.lines[pi];
      if (shared !== undefined) out.push(shared);
      i = pi + 1;
      j = pj + 1;
    }
  }
  return textOf(out, o.trailingNewline || t.trailingNewline);
};

/** Claude's `MEMORY.md` (and Codex's): an index, one line per memory. */
export const isAgentMemoryIndex = (filePath: string): boolean =>
  filePath === "MEMORY.md" || filePath.endsWith("/MEMORY.md");

/** Each non-blank line once, at its first place: what an index merge leaves. */
export const withoutRepeatedLines = (text: string): string => {
  const { lines, trailingNewline } = linesOf(text);
  const seen = new Set<string>();
  const kept = lines.filter((line) => {
    if (line.trim() === "") return true;
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

/** A file's YAML frontmatter and body, or null when it does not open with `---`. */
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

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:/;

/**
 * Frontmatter as keyed entries: a `key:` line and the lines under it (indented values, list items,
 * comments). Lines before the first key are one entry keyed "". A key written twice keeps both,
 * as `key`, `key#2`.
 */
const entriesOf = (lines: ReadonlyArray<string>): ReadonlyMap<string, ReadonlyArray<string>> => {
  const entries: Array<{ key: string; lines: Array<string> }> = [];
  for (const line of lines) {
    const key = KEY.exec(line)?.[1];
    const last = entries.at(-1);
    if (key === undefined && last !== undefined) last.lines.push(line);
    else entries.push({ key: key ?? "", lines: [line] });
  }
  const keyed = new Map<string, ReadonlyArray<string>>();
  for (const entry of entries) {
    let key = entry.key;
    for (let n = 2; keyed.has(key); n += 1) key = `${entry.key}#${n}`;
    keyed.set(key, entry.lines);
  }
  return keyed;
};

const isComment = (line: string) => line.trimStart().startsWith("#");
/** An entry's value: its lines that are not comments. */
const valueOf = (entry: ReadonlyArray<string> | undefined): string | undefined =>
  entry?.filter((line) => !isComment(line)).join("\n");

/**
 * Two frontmatters merged key by key, against `base` when there is one. A key one side changed
 * since `base` takes that side's value; a key both set differently keeps `ours` and adds `theirs`
 * under it as comments (`# <note>: key: value`). Keys keep `ours`' order, then `theirs`' new ones.
 * Comments already in an entry stay with it.
 */
export const mergeFrontmatterLines = (input: {
  readonly ours: ReadonlyArray<string>;
  readonly theirs: ReadonlyArray<string>;
  readonly base: ReadonlyArray<string> | null;
  /** Who `theirs` came from, for the comment: `from laptop, 2026-10-04`. */
  readonly note: string;
}): ReadonlyArray<string> => {
  const ours = entriesOf(input.ours);
  const theirs = entriesOf(input.theirs);
  const base = input.base === null ? null : entriesOf(input.base);
  const keys = [...ours.keys(), ...[...theirs.keys()].filter((key) => !ours.has(key))];
  const out: Array<string> = [];
  for (const key of keys) {
    const s = ours.get(key);
    const t = theirs.get(key);
    const sv = valueOf(s);
    const tv = valueOf(t);
    const bv = base === null ? undefined : valueOf(base.get(key));
    const unchangedSince = (value: string | undefined) => base !== null && value === bv;
    if (t === undefined) {
      // Theirs lacks it: removed there when ours still holds it as it was, else ours stands.
      if (s !== undefined && !unchangedSince(sv)) out.push(...s);
      continue;
    }
    if (s === undefined) {
      if (!unchangedSince(tv)) out.push(...t);
      continue;
    }
    if (sv === tv || unchangedSince(tv)) {
      out.push(...s);
      continue;
    }
    if (unchangedSince(sv)) {
      // Theirs is the change: its value, with any comments ours kept.
      out.push(...t, ...s.filter(isComment).filter((line) => !t.includes(line)));
      continue;
    }
    const comments = t
      .filter((line) => !isComment(line))
      .map((line) => `# ${input.note}: ${line}`)
      .filter((line) => !s.includes(line));
    out.push(...s, ...comments);
  }
  return out;
};
