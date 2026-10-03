/**
 * A sorted copy that leaves `values` as it was. `toSorted` would do, but the phone's runtime does
 * not have it; a stable insertion keeps equal values in their order.
 */
export const sortedCopy = <T>(
  values: ReadonlyArray<T>,
  compare: (left: T, right: T) => number,
): ReadonlyArray<T> =>
  values.reduce<ReadonlyArray<T>>((ordered, value) => {
    const insertion = ordered.findIndex((existing) => compare(value, existing) < 0);
    return insertion === -1
      ? [...ordered, value]
      : [...ordered.slice(0, insertion), value, ...ordered.slice(insertion)];
  }, []);
