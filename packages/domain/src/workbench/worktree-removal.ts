/**
 * What a refused worktree removal says (docs/adr/0007-landing.md, "Worktree removal"). The server
 * writes the refusal in words; this module is the one place those words are shaped and read, so
 * a client that offers "Remove anyway" offers it exactly when `force=true` would lift the refusal,
 * and shows what the change holds from the words it was given.
 */

/** A file's lines not on origin, as the store counts them. */
export interface UnlandedFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** How many files a refusal names before counting the rest. */
export const UNLANDED_NAMED_FILES = 5;

/**
 * The tail of every refusal `force=true` lifts. A refusal without it, such as a capture still
 * saving, is not lifted by force, and a client offers no override for it.
 */
export const WORKTREE_REMOVAL_FORCE_HINT = "or pass force=true to remove it anyway";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** `3 files · +12 −3 · src/a.ts +10 −2, src/b.ts +2 −1, docs/c.md +0 −0` */
export const describeUnlanded = (files: ReadonlyArray<UnlandedFile>): string => {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const named = files
    .slice(0, UNLANDED_NAMED_FILES)
    .map((file) => `${file.path} +${file.additions} −${file.deletions}`)
    .join(", ");
  const more =
    files.length > UNLANDED_NAMED_FILES ? `, ${files.length - UNLANDED_NAMED_FILES} more` : "";
  return `${plural(files.length, "file", "files")} · +${additions} −${deletions} · ${named}${more}`;
};

/** What a refusal says the worktree holds that is not on origin. */
export interface UnlandedFacts {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  /** The first files, as the refusal names them. */
  readonly named: ReadonlyArray<UnlandedFile>;
  /** Files past the named ones, counted. */
  readonly more: number;
}

const FACTS = /(\d+) files? · \+(\d+) −(\d+) · (.+?)(?:\. [A-Z]|$)/;
const NAMED = /^(.+) \+(\d+) −(\d+)$/;
const MORE = /^(\d+) more$/;

/** The facts `describeUnlanded` wrote into a refusal, or null when the words carry none. */
export const unlandedFactsOf = (words: string): UnlandedFacts | null => {
  const match = FACTS.exec(words);
  if (match === null) return null;
  const [, files, additions, deletions, list] = match;
  if (
    files === undefined ||
    additions === undefined ||
    deletions === undefined ||
    list === undefined
  )
    return null;
  const named: Array<UnlandedFile> = [];
  let more = 0;
  for (const item of list.split(", ")) {
    const counted = MORE.exec(item);
    if (counted?.[1] !== undefined) {
      more = Number(counted[1]);
      continue;
    }
    const file = NAMED.exec(item);
    if (file?.[1] === undefined || file[2] === undefined || file[3] === undefined) return null;
    named.push({ path: file[1], additions: Number(file[2]), deletions: Number(file[3]) });
  }
  return {
    files: Number(files),
    additions: Number(additions),
    deletions: Number(deletions),
    named,
    more,
  };
};

/** A refused removal, read from the server's words. */
export interface WorktreeRemovalRefusal {
  /** The server's words, verbatim. */
  readonly words: string;
  /** Whether `force=true` lifts this refusal. */
  readonly forceable: boolean;
  /** What is not on origin, when the words name it. */
  readonly unlanded: UnlandedFacts | null;
}

export const worktreeRemovalRefusalOf = (words: string): WorktreeRemovalRefusal => ({
  words,
  forceable: words.includes(WORKTREE_REMOVAL_FORCE_HINT),
  unlanded: unlandedFactsOf(words),
});
