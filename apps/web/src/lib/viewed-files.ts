import { createLocalStore } from "./local-store.ts";

/** The files of one change marked viewed: each path with the fingerprint of the version marked. */
export type ViewedMarks = Readonly<Record<string, string>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What this browser kept, read back; anything that isn't a path-to-fingerprint map is no marks. */
export const parseViewedMarks = (stored: unknown): ViewedMarks => {
  if (!isRecord(stored)) return {};
  const marks: Record<string, string> = {};
  for (const [path, fingerprint] of Object.entries(stored))
    if (typeof fingerprint === "string") marks[path] = fingerprint;
  return marks;
};

/** Whether `path` is marked viewed as it is now: a file that changed since its mark reads unviewed. */
export const isViewed = (marks: ViewedMarks, path: string, fingerprint: string): boolean =>
  marks[path] === fingerprint;

/** The marks after a person ticks (`viewed` true) or unticks one file at its current version. */
export const markViewed = (
  marks: ViewedMarks,
  path: string,
  fingerprint: string,
  viewed: boolean,
): ViewedMarks => {
  const rest = Object.fromEntries(Object.entries(marks).filter(([marked]) => marked !== path));
  return viewed ? { ...rest, [path]: fingerprint } : rest;
};

const stores = new Map<string, ReturnType<typeof makeStore>>();

const makeStore = (changeId: string) =>
  createLocalStore<ViewedMarks>(`mend-viewed-files-${changeId}`, parseViewedMarks, {});

/**
 * The files of a change this person marked viewed, kept in this browser. A mark is a reading aid,
 * never a review verdict, so it stays on this machine. It is kept in localStorage rather than a
 * cookie: a big change's paths would outgrow a cookie, and the marks only fold files, so reading
 * them after the page hydrates moves nothing a person was reading.
 */
export const viewedFiles = (changeId: string) => {
  const existing = stores.get(changeId);
  if (existing !== undefined) return existing;
  const created = makeStore(changeId);
  stores.set(changeId, created);
  return created;
};
