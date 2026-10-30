export interface ProjectReadOrder {
  readonly begin: () => number;
  readonly removed: (id: string) => void;
  /** A full snapshot begun at `started` was applied: it speaks for every project, absent ones too. */
  readonly snapshot: (started: number) => void;
  readonly apply: (id: string, started: number) => boolean;
  readonly newerThan: (id: string, started: number) => boolean;
}

// Keep the high-water mark after Restore, or a delayed old 404 could hide it again. A full
// snapshot is a mark for every id: a project absent from it and from the cache has no mark of
// its own, and an older read of it must not bring it back.
export const makeProjectReadOrder = (): ProjectReadOrder => {
  let tick = 0;
  let snapshot = 0;
  const applied = new Map<string, number>();
  const markOf = (id: string) => Math.max(applied.get(id) ?? 0, snapshot);
  return {
    begin: () => ++tick,
    removed: (id) => {
      applied.set(id, ++tick);
    },
    snapshot: (started) => {
      snapshot = Math.max(snapshot, started);
    },
    newerThan: (id, started) => (applied.get(id) ?? 0) > started,
    apply: (id, started) => {
      if (markOf(id) > started) return false;
      applied.set(id, started);
      return true;
    },
  };
};
