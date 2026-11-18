import type { ReviewDiffFileDto } from "./api.ts";

/**
 * Lock files and other files a tool writes, by name: the Change view folds them, since a person
 * rarely reads one line by line. Their counts still show.
 */
const GENERATED_NAMES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "Package.resolved",
  "packages.lock.json",
  "gradle.lockfile",
]);

/** Names a tool gives what it writes: `routeTree.gen.ts`, `schema.generated.ts`, `app.min.js`. */
const GENERATED_PATTERN = /(?:\.gen|\.generated|\.min)\.[a-z0-9]+$/i;

/** Whether a tool wrote this file: a lock file, or a name only a generator gives. */
export const isGenerated = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return GENERATED_NAMES.has(name) || GENERATED_PATTERN.test(name);
};

/**
 * A short fingerprint of what a file's change says: a mark made on one version of the file is not
 * a mark on the next. Not a security hash; two different patches agreeing is harmless here.
 */
export const patchFingerprint = (patch: string): string => {
  let hash = 5381;
  for (let index = 0; index < patch.length; index += 1)
    hash = ((hash * 33) ^ patch.charCodeAt(index)) >>> 0;
  return `${patch.length.toString(36)}.${hash.toString(36)}`;
};

/** One changed file, as the file list and its diff show it. */
export interface ChangeFile {
  /** Its path now (the old one for a deleted file): the key everything else uses. */
  readonly path: string;
  /** Where it was, for a renamed or copied file; null otherwise. */
  readonly from: string | null;
  /** The folder, ending in "/", or "" at the top. */
  readonly dir: string;
  readonly name: string;
  readonly status: ReviewDiffFileDto["status"];
  readonly binary: boolean;
  readonly generated: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly fingerprint: string;
  readonly file: ReviewDiffFileDto;
}

const splitPath = (path: string) => {
  const at = path.lastIndexOf("/");
  return { dir: at === -1 ? "" : path.slice(0, at + 1), name: path.slice(at + 1) };
};

export const changeFileOf = (file: ReviewDiffFileDto): ChangeFile => {
  const path = file.newPath ?? file.oldPath ?? "";
  const moved = file.status === "renamed" || file.status === "copied";
  return {
    path,
    from: moved && file.oldPath !== null && file.oldPath !== path ? file.oldPath : null,
    ...splitPath(path),
    status: file.status,
    binary: file.binary,
    generated: isGenerated(path),
    additions: file.additions,
    deletions: file.deletions,
    fingerprint: patchFingerprint(file.patch),
    file,
  };
};

/** A folder of the file list with its files, or (folder null) the files listed by their path. */
export interface FileGroup {
  readonly folder: string | null;
  readonly files: ReadonlyArray<ChangeFile>;
}

/**
 * The file list's groups, in the order the diffs follow: first the files that are alone in their
 * folder, by their whole path, then each folder holding two or more changed files, its files by
 * name under it. Within each part, paths sort as git sorts them.
 */
export const fileGroups = (files: ReadonlyArray<ChangeFile>): ReadonlyArray<FileGroup> => {
  const byPath = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const counts = new Map<string, number>();
  for (const file of byPath) counts.set(file.dir, (counts.get(file.dir) ?? 0) + 1);
  const alone = (file: ChangeFile) => file.dir === "" || counts.get(file.dir) === 1;
  const loose = byPath.filter(alone);
  const folders: Array<FileGroup> = [];
  for (const file of byPath) {
    if (alone(file)) continue;
    const folder = file.dir.slice(0, -1);
    const last = folders.at(-1);
    if (last?.folder === folder)
      folders[folders.length - 1] = { folder, files: [...last.files, file] };
    else folders.push({ folder, files: [file] });
  }
  return loose.length === 0 ? folders : [{ folder: null, files: loose }, ...folders];
};

/** The files in the order the list shows them, which the diffs follow. */
export const orderedFiles = (groups: ReadonlyArray<FileGroup>): ReadonlyArray<ChangeFile> =>
  groups.flatMap((group) => group.files);

/** The groups with only the files whose path holds `query` (any case); empty groups go. */
export const filterGroups = (
  groups: ReadonlyArray<FileGroup>,
  query: string,
): ReadonlyArray<FileGroup> => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return groups;
  return groups
    .map((group) => ({
      ...group,
      files: group.files.filter((file) => file.path.toLowerCase().includes(needle)),
    }))
    .filter((group) => group.files.length > 0);
};

/** What a file's header and row say about it beside its counts, or null for a plain edit. */
export const fileNote = (file: ChangeFile): string | null => {
  if (file.generated) return "Generated";
  if (file.binary) return "Binary";
  switch (file.status) {
    case "added":
      return "New file";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    case "type-changed":
      return "Type changed";
    default:
      return null;
  }
};

/** "+1,284", or "" when nothing was added: an empty count hides. */
export const addedWords = (count: number): string =>
  count === 0 ? "" : `+${count.toLocaleString("en")}`;

/** "−1,102" with a real minus sign, or "" when nothing was removed. */
export const removedWords = (count: number): string =>
  count === 0 ? "" : `−${count.toLocaleString("en")}`;
