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

/** The list runs up to the sentence the server always closes it with: `. Land it …`. */
const FACTS = /(\d+) files? · \+(\d+) −(\d+) · (.+?)(?:\. Land it\b|$)/;
const NAMED = /^(.+) \+(\d+) −(\d+)$/;
const MORE = /^(\d+) more$/;

/**
 * The facts `describeUnlanded` wrote into a refusal, or null when the words carry none. The words
 * are plain text, so a path holding `, ` or `. Land it`, or one that reads like `2 more`, can make
 * them ambiguous: this reading is exact or absent, never a guess. Every count the words carry
 * must agree before anything is returned, and the words themselves stay the authority.
 */
export const unlandedFactsOf = (words: string): UnlandedFacts | null => {
  const match = FACTS.exec(words);
  if (match === null) return null;
  const [, filesText, additionsText, deletionsText, list] = match;
  if (
    filesText === undefined ||
    additionsText === undefined ||
    deletionsText === undefined ||
    list === undefined
  )
    return null;
  const files = Number(filesText);
  const additions = Number(additionsText);
  const deletions = Number(deletionsText);
  const items = list.split(", ");
  const last = items.at(-1);
  const counted = last === undefined ? null : MORE.exec(last);
  const more = counted?.[1] === undefined ? 0 : Number(counted[1]);
  const named: Array<UnlandedFile> = [];
  for (const item of more > 0 ? items.slice(0, -1) : items) {
    const file = NAMED.exec(item);
    if (file?.[1] === undefined || file[2] === undefined || file[3] === undefined) return null;
    named.push({ path: file[1], additions: Number(file[2]), deletions: Number(file[3]) });
  }
  // What the server wrote always satisfies these; a reading that does not misread the words.
  if (named.length === 0 || named.length > UNLANDED_NAMED_FILES) return null;
  if (named.length + more !== files) return null;
  if (more > 0 !== files > UNLANDED_NAMED_FILES) return null;
  if (
    more === 0 &&
    (named.reduce((sum, file) => sum + file.additions, 0) !== additions ||
      named.reduce((sum, file) => sum + file.deletions, 0) !== deletions)
  )
    return null;
  return { files, additions, deletions, named, more };
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

/** A repository a session of the worktree added with `mend repo add`, as removal names it. */
export interface HeldRepository {
  readonly path: string;
  readonly branch: string;
  /** Where its files are saved: `nested` ones live inside this worktree and go with it. */
  readonly capture: "nested" | "own";
}

/**
 * Why removal must be asked again with `force`, for the repositories this worktree's sessions
 * added (docs/adr/0011-repositories-in-a-session.md), or null when it holds none. Until sealantd
 * captures repository roots, a repository's files, history included, live nested inside the main
 * worktree and are saved only with it, and Mend reads none of them: its own change stays at its
 * start. So every nested repository counts as work that may not be on origin, and removal is
 * refused as it is for an unlanded change. One saved under its own captures does not go with this
 * worktree and is not named.
 */
export const heldRepositoriesRefusal = (
  repositories: ReadonlyArray<HeldRepository>,
): string | null => {
  const nested = repositories.filter((repository) => repository.capture === "nested");
  if (nested.length === 0) return null;
  const named = nested
    .slice(0, UNLANDED_NAMED_FILES)
    .map((repository) => `${repository.path} on ${repository.branch}`)
    .join(", ");
  const more =
    nested.length > UNLANDED_NAMED_FILES ? `, ${nested.length - UNLANDED_NAMED_FILES} more` : "";
  const one = nested.length === 1;
  return `This worktree holds ${plural(nested.length, "repository", "repositories")} added with mend repo add, saved only with it · ${named}${more} · Mend cannot see whether ${one ? "it holds" : "they hold"} commits or edits that are not on origin, and removal deletes ${one ? "it" : "them"}. Push what you need from a session in this worktree before removal, ${WORKTREE_REMOVAL_FORCE_HINT}.`;
};
