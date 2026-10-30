export interface ProjectReadOrder {
  readonly begin: () => number;
  readonly removed: (id: string) => void;
  readonly apply: (id: string, started: number) => boolean;
  readonly newerThan: (id: string, started: number) => boolean;
}

// Keep the high-water mark after Restore, or a delayed old 404 could hide it again.
export const makeProjectReadOrder = (): ProjectReadOrder => {
  let tick = 0;
  const applied = new Map<string, number>();
  return {
    begin: () => ++tick,
    removed: (id) => {
      applied.set(id, ++tick);
    },
    newerThan: (id, started) => (applied.get(id) ?? 0) > started,
    apply: (id, started) => {
      if ((applied.get(id) ?? 0) > started) return false;
      applied.set(id, started);
      return true;
    },
  };
};
