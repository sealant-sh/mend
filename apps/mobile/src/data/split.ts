// Two sessions on one screen (the `/split` route): which sessions, in which order, carried in the
// route's `ids` parameter so a split survives a rotation, a fold and a trip to another screen.

/** A split holds two sessions: side by side when open flat, one above the other upright. */
export const SPLIT_MAX = 2;

/** The sessions a split names, in order, without blanks or repeats, at most `SPLIT_MAX`. */
export const splitIdsOf = (param: string | ReadonlyArray<string> | undefined): Array<string> => {
  const raw = param === undefined ? [] : typeof param === "string" ? [param] : param;
  const ids: Array<string> = [];
  for (const id of raw.flatMap((value) => value.split(","))) {
    const trimmed = id.trim();
    if (trimmed === "" || ids.includes(trimmed)) continue;
    ids.push(trimmed);
    if (ids.length === SPLIT_MAX) break;
  }
  return ids;
};

export const splitParam = (ids: ReadonlyArray<string>): string => ids.join(",");

/** Put `id` in the split; one already there stays where it is. A full split replaces its last. */
export const withSession = (ids: ReadonlyArray<string>, id: string): Array<string> => {
  if (ids.includes(id)) return [...ids];
  if (ids.length < SPLIT_MAX) return [...ids, id];
  return [...ids.slice(0, SPLIT_MAX - 1), id];
};

export const withoutSession = (ids: ReadonlyArray<string>, id: string): Array<string> =>
  ids.filter((candidate) => candidate !== id);
