/** Where a query matched inside a text, and how well. */
export interface FuzzyMatch {
  readonly score: number;
  /** Indexes of the matched characters in the text, ascending. */
  readonly indices: ReadonlyArray<number>;
}

const isBoundary = (text: string, index: number) =>
  index === 0 || /[\s/\-_.:@]/.test(text.charAt(index - 1));

/**
 * The query's characters in order inside the text, case-insensitive, like `mend` in the
 * terminal: `stab` matches `settings-tabs`. A run of adjacent characters and a match at the
 * start of a word score higher; an earlier first match breaks ties. Null when it does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { score: 0, indices: [] };
  const haystack = text.toLowerCase();
  const indices: Array<number> = [];
  let score = 0;
  let from = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, from);
    if (found === -1) return null;
    const previous = indices.at(-1);
    if (previous !== undefined && found === previous + 1) score += 3;
    if (isBoundary(text, found)) score += 2;
    indices.push(found);
    from = found + 1;
  }
  return { score: score - (indices[0] ?? 0) * 0.01, indices };
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
