/**
 * The extensions a person picked for each project, as one book in global state that Settings Sync
 * carries. Many windows and machines write it and replay their writes, so each (project, id) keeps
 * the latest entry, a removal stays as a tombstone, and merging is commutative, associative and
 * idempotent.
 */
declare const extensionIdBrand: unique symbol;
/** `publisher.name`, lowercased. */
export type ExtensionId = string & { readonly [extensionIdBrand]: true };

declare const projectIdBrand: unique symbol;
export type ProjectId = string & { readonly [projectIdBrand]: true };

const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

const isExtensionId = (value: string): value is ExtensionId => EXTENSION_ID.test(value);

export const extensionId = (raw: string): ExtensionId | null => {
  const id = raw.toLowerCase();
  return isExtensionId(id) ? id : null;
};

const isProjectId = (value: string): value is ProjectId => value !== "";

export const projectId = (raw: string): ProjectId | null => (isProjectId(raw) ? raw : null);

/** `at` is the observing machine's clock. */
export type PickEntry =
  | { readonly kind: "picked"; readonly at: number; readonly preRelease: boolean }
  | { readonly kind: "removed"; readonly at: number };

export type ProjectPicks = ReadonlyMap<ExtensionId, PickEntry>;

export interface PickBook {
  readonly projects: ReadonlyMap<ProjectId, ProjectPicks>;
}

/** One key for every project: Settings Sync applies only the keys a machine lists. */
export const PICKS_KEY = "mend.editor.picks";

export const emptyBook: PickBook = { projects: new Map() };

const BOOK_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rank = (entry: PickEntry): number =>
  entry.kind === "removed" ? 0 : entry.preRelease ? 2 : 1;

/** The later entry wins; on a tie a pick wins, so no merge order loses a pick. */
const winner = (left: PickEntry, right: PickEntry): PickEntry => {
  if (left.at !== right.at) return left.at > right.at ? left : right;
  return rank(left) >= rank(right) ? left : right;
};

const sameEntry = (left: PickEntry, right: PickEntry): boolean =>
  left.kind === right.kind &&
  left.at === right.at &&
  (left.kind === "removed" || (right.kind === "picked" && left.preRelease === right.preRelease));

export const mergePicks = (left: ProjectPicks, right: ProjectPicks): ProjectPicks => {
  const merged = new Map(left);
  for (const [id, entry] of right) {
    const current = merged.get(id);
    merged.set(id, current === undefined ? entry : winner(current, entry));
  }
  return merged;
};

export const withEntries = (
  book: PickBook,
  project: ProjectId,
  entries: ProjectPicks,
): PickBook => {
  if (entries.size === 0) return book;
  const projects = new Map(book.projects);
  projects.set(project, mergePicks(book.projects.get(project) ?? new Map(), entries));
  return { projects };
};

/** True exactly when `withEntries` would change nothing: the book already reflects the entries. */
export const holds = (book: PickBook, project: ProjectId, entries: ProjectPicks): boolean => {
  const picks = book.projects.get(project);
  return [...entries].every(([id, entry]) => {
    const current = picks?.get(id);
    return current !== undefined && sameEntry(current, winner(current, entry));
  });
};

export interface Wanted {
  readonly id: ExtensionId;
  readonly preRelease: boolean;
}

export const wantedBy = (book: PickBook, project: ProjectId): ReadonlyArray<Wanted> =>
  [...(book.projects.get(project) ?? new Map<ExtensionId, PickEntry>())]
    .flatMap(
      ([id, entry]): Array<Wanted> =>
        entry.kind === "picked" ? [{ id, preRelease: entry.preRelease }] : [],
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));

const parseEntry = (value: unknown): PickEntry | null => {
  if (!isRecord(value)) return null;
  const { kind, at, preRelease } = value;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (kind === "removed") return { kind, at };
  return kind === "picked" && typeof preRelease === "boolean" ? { kind, at, preRelease } : null;
};

const parseProjectPicks = (value: unknown): ProjectPicks | null => {
  if (!isRecord(value)) return null;
  let picks: ProjectPicks = new Map();
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = extensionId(rawId);
    const entry = parseEntry(rawEntry);
    if (id === null || entry === null) return null;
    picks = mergePicks(picks, new Map([[id, entry]]));
  }
  return picks;
};

/**
 * `undefined` is the empty book. Anything else that does not parse, such as a newer version from
 * another machine, is `unreadable`, and Mend never writes over it.
 */
export const parsePickBook = (stored: unknown): PickBook | "unreadable" => {
  if (stored === undefined) return emptyBook;
  if (!isRecord(stored) || stored["version"] !== BOOK_VERSION) return "unreadable";
  const rawProjects = stored["projects"];
  if (!isRecord(rawProjects)) return "unreadable";
  const projects = new Map<ProjectId, ProjectPicks>();
  for (const [rawProject, rawPicks] of Object.entries(rawProjects)) {
    const project = projectId(rawProject);
    const picks = parseProjectPicks(rawPicks);
    if (project === null || picks === null) return "unreadable";
    projects.set(project, picks);
  }
  return { projects };
};

export const storedBook = (book: PickBook) => ({
  version: BOOK_VERSION,
  projects: Object.fromEntries(
    [...book.projects].map(([project, picks]) => [project, Object.fromEntries(picks)]),
  ),
});
