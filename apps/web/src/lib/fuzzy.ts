/** Where a query matched inside a text, and how well. */
export interface FuzzyMatch {
  readonly score: number;
  /** Indexes of the matched characters in the text, ascending. */
  readonly indices: ReadonlyArray<number>;
}

const isBoundary = (text: string, index: number) =>
  index === 0 || /[\s/\-_.:@]/.test(text.charAt(index - 1));

/**
 * A run of adjacent characters and a match at the start of a word score higher; an earlier first
 * match breaks ties.
 */
const scoreOf = (text: string, indices: ReadonlyArray<number>): number => {
  let score = 0;
  indices.forEach((index, at) => {
    if (at > 0 && index === (indices[at - 1] ?? -2) + 1) score += 3;
    if (isBoundary(text, index)) score += 2;
  });
  return score - (indices[0] ?? 0) * 0.01;
};

/** The first word starting with `character` at or after `from`; -1 if none. */
const nextWordStart = (text: string, haystack: string, character: string, from: number): number => {
  for (
    let at = haystack.indexOf(character, from);
    at !== -1;
    at = haystack.indexOf(character, at + 1)
  )
    if (isBoundary(text, at)) return at;
  return -1;
};

/** The best place the query appears whole in the text, a word start first; null if nowhere. */
const runMatch = (needle: string, text: string, haystack: string): FuzzyMatch | null => {
  let best: FuzzyMatch | null = null;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const indices = Array.from({ length: needle.length }, (_, offset) => at + offset);
    const score = scoreOf(text, indices);
    if (best === null || score > best.score) best = { score, indices };
  }
  return best;
};

/**
 * The query inside the text, case-insensitive. Where it appears whole, that run is the match, so
 * `land` in "Fix landing" marks "land". Otherwise its characters in order, each one either right
 * after the one before or at the start of a word: `stab` matches `settings-tabs` and `fcr`
 * matches "Fix checkout retry", but `land` doesn't match "release-notes-xyhd", whose l, a, n
 * and d are scattered inside words. Null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const run = runMatch(needle, text, haystack);
  if (run !== null) return run;
  const indices: Array<number> = [];
  for (const character of needle) {
    const previous = indices.at(-1);
    if (previous !== undefined && haystack.charAt(previous + 1) === character) {
      indices.push(previous + 1);
      continue;
    }
    const found = nextWordStart(text, haystack, character, (previous ?? -1) + 1);
    if (found === -1) return null;
    indices.push(found);
  }
  return { score: scoreOf(text, indices), indices };
}

/** Every item that matches, best first; with an empty query, all of them in their own order. */
export function fuzzyFilter<T>(
  items: ReadonlyArray<T>,
  query: string,
  text: (item: T) => string,
): ReadonlyArray<{ readonly item: T; readonly match: FuzzyMatch }> {
  const matched = items.flatMap((item) => {
    const match = fuzzyMatch(query, text(item));
    return match === null ? [] : [{ item, match }];
  });
  return query.trim() === "" ? matched : matched.toSorted((a, b) => b.match.score - a.match.score);
}
