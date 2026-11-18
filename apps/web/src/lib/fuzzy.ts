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
 * The query's characters in order inside the text, case-insensitive, like `mend` in the
 * terminal: `stab` matches `settings-tabs`. Where the query appears whole, that run is the match,
 * so `land` in "Fix landing" marks "land" rather than a scattered l, a, n, d. Null when it does
 * not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const run = runMatch(needle, text, haystack);
  if (run !== null) return run;
  const indices: Array<number> = [];
  let from = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, from);
    if (found === -1) return null;
    indices.push(found);
    from = found + 1;
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
