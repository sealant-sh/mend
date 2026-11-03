import { createLocalStore } from "./local-store.ts";

const stores = new Map<string, ReturnType<typeof makeStore>>();

const makeStore = (changeId: string) =>
  createLocalStore<ReadonlyArray<string>>(
    `mend-viewed-${changeId}`,
    (stored) =>
      Array.isArray(stored)
        ? stored.filter((path): path is string => typeof path === "string")
        : [],
    [],
  );

/**
 * The files of a change this person marked viewed, kept per browser. A mark is a reading aid,
 * never a review verdict, so it stays on this machine.
 */
export const viewedFiles = (changeId: string) => {
  const existing = stores.get(changeId);
  if (existing !== undefined) return existing;
  const created = makeStore(changeId);
  stores.set(changeId, created);
  return created;
};
