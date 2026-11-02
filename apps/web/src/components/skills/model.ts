/** Pure view logic for the skill library and a skill's page (screens M1 to M3). */

/** A bundle's size the way the library lists it: 812 B, 22 KB, 1.4 MB. */
export const formatBundleSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** "6 files · 38 KB". */
export const bundleShape = (skill: { readonly fileCount: number; readonly bytes: number }) =>
  `${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"} · ${formatBundleSize(skill.bytes)}`;

export interface DraftFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * The files a draft changes against what was saved: edited, added or removed, by path. The
 * Save bar counts them ("1 file changed").
 */
export const changedFiles = (
  saved: ReadonlyArray<DraftFile>,
  draft: ReadonlyArray<DraftFile>,
): ReadonlyArray<string> => {
  const before = new Map(saved.map((file) => [file.path, file.contents]));
  const after = new Map(draft.map((file) => [file.path, file.contents]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
};

export const changedFilesWords = (count: number): string =>
  count === 0 ? "no changes" : `${count} file${count === 1 ? "" : "s"} changed`;

/**
 * Which lines of `after` differ from `before`: everything between their longest common prefix
 * and longest common suffix. One inserted line marks that line alone, not every line after it.
 */
export const changedLines = (before: string, after: string): ReadonlySet<number> => {
  const old = before.split("\n");
  const now = after.split("\n");
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start += 1;
  let endOld = old.length - 1;
  let endNow = now.length - 1;
  while (endOld >= start && endNow >= start && old[endOld] === now[endNow]) {
    endOld -= 1;
    endNow -= 1;
  }
  const marked = new Set<number>();
  for (let line = start; line <= endNow; line += 1) marked.add(line);
  return marked;
};

/** The file a skill page shows: the one named in the URL when the bundle has it, else SKILL.md. */
export const shownFile = <F extends DraftFile>(
  files: ReadonlyArray<F>,
  requested: string | undefined,
): F | undefined =>
  files.find((file) => file.path === requested) ??
  files.find((file) => file.path === "SKILL.md") ??
  files[0];
