import { SkillsRepo, type SkillBundleInput, type SkillWriteError } from "@mend/db";
import type { ProjectId, Sha } from "@mend/domain";
import {
  SKILL_ENTRY_FILE,
  SKILL_MAX_BYTES,
  SKILL_MAX_DESCRIPTION_LENGTH,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_MAX_PER_SCOPE,
  validateSkillBundle,
  validateSkillFilePath,
  validateSkillName,
} from "@mend/domain/workbench";
import { type GitError, Store, type SubtreeBlobEntry } from "@mend/store";
import { Effect } from "effect";

/** Repository directory scanned for project skills at adoption time. */
export const ADOPTION_SKILLS_DIR = ".agents/skills";

const ADOPTION_SKILLS_PREFIX = `${ADOPTION_SKILLS_DIR}/`;

/** Upper bound on `ls-tree` entries scanned during adoption so oversized trees cannot exhaust memory. */
const MAX_ADOPTION_SKILL_BLOBS = 4096;

/** Bounded concurrency for reading skill blobs out of the newly adopted bare repository. */
const BLOB_READ_CONCURRENCY = 8;

const IGNORED_SEGMENTS = new Set([".git", "node_modules", "__pycache__"]);

const utf8Decoder = new TextDecoder("utf-8");

export interface CandidateSkillFile {
  readonly repoPath: string;
  readonly skillPath: string;
  readonly size: number;
}

export interface CandidateSkillBundle {
  readonly name: string;
  readonly files: ReadonlyArray<CandidateSkillFile>;
}

/**
 * Pull a single-line `description:` value from YAML frontmatter (`--- ... ---`), matching the CLI's
 * `mend skills push` scanner. Multiline block scalars or absent fields read as empty.
 */
export const readSkillFrontmatterDescription = (contents: string): string => {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) return "";
  const end = contents.indexOf("\n---", 3);
  if (end === -1) return "";
  for (const line of contents.slice(0, end).split("\n")) {
    const match = /^description:\s*(.*)$/.exec(line.replace(/\r$/, ""));
    if (match === null) continue;
    const raw = (match[1] ?? "").trim();
    if (raw === "" || raw === "|" || raw === ">" || raw === "|-" || raw === ">-") return "";
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    const description = quoted?.[2] ?? raw;
    return description.length <= SKILL_MAX_DESCRIPTION_LENGTH ? description : "";
  }
  return "";
};

const compareCodePoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group regular `.agents/skills/<name>/...` blobs into candidate project skill bundles, skipping
 * hidden directories, ignored directories, invalid names/paths, oversized files, directories
 * without `SKILL.md`, bundles over the file/byte caps, and case-colliding directories.
 */
export const selectAdoptedSkillFiles = (
  entries: ReadonlyArray<SubtreeBlobEntry>,
): ReadonlyArray<CandidateSkillBundle> => {
  const byDir = new Map<string, Array<CandidateSkillFile>>();
  for (const entry of entries) {
    if (!entry.path.startsWith(ADOPTION_SKILLS_PREFIX)) continue;
    const rest = entry.path.slice(ADOPTION_SKILLS_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const rawDir = rest.slice(0, slash);
    const skillPath = rest.slice(slash + 1);
    if (rawDir.startsWith(".")) continue;
    if (skillPath.split("/").some((segment) => IGNORED_SEGMENTS.has(segment))) continue;
    if (validateSkillFilePath(skillPath) !== null) continue;
    if (entry.size > SKILL_MAX_FILE_BYTES) continue;
    const name = rawDir.toLowerCase();
    if (validateSkillName(name) !== null) continue;
    const bucket = byDir.get(rawDir);
    const file: CandidateSkillFile = { repoPath: entry.path, skillPath, size: entry.size };
    if (bucket === undefined) byDir.set(rawDir, [file]);
    else bucket.push(file);
  }

  // Prefer the exact-lowercase directory name when two directories differ only by case; otherwise
  // order deterministically by code point so selection never depends on host locale.
  const orderedDirs = [...byDir.keys()].toSorted((a, b) => {
    const lowerA = a.toLowerCase();
    const lowerB = b.toLowerCase();
    if (lowerA !== lowerB) return compareCodePoints(lowerA, lowerB);
    if (a === lowerA && b !== lowerB) return -1;
    if (b === lowerB && a !== lowerA) return 1;
    return compareCodePoints(a, b);
  });

  const seenNames = new Set<string>();
  const selected: Array<CandidateSkillBundle> = [];
  for (const rawDir of orderedDirs) {
    const name = rawDir.toLowerCase();
    if (seenNames.has(name)) continue;
    const files = (byDir.get(rawDir) ?? []).toSorted((a, b) =>
      compareCodePoints(a.skillPath, b.skillPath),
    );
    if (files.length === 0 || files.length > SKILL_MAX_FILES) continue;
    if (!files.some((file) => file.skillPath === SKILL_ENTRY_FILE)) continue;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > SKILL_MAX_BYTES) continue;
    seenNames.add(name);
    selected.push({ name, files });
    if (selected.length >= SKILL_MAX_PER_SCOPE) break;
  }
  return selected;
};

/**
 * Scan `.agents/skills` on the newly adopted commit and sync valid bundles into that project's own
 * skill library (`scope: "project"`). Never touches the adopter's personal skill library.
 */
export const importAdoptedProjectSkills = Effect.fnUntraced(function* (input: {
  readonly projectId: ProjectId;
  readonly storePath: string;
  readonly headSha: Sha;
}): Effect.fn.Return<number, GitError | SkillWriteError, Store | SkillsRepo> {
  const store = yield* Store;
  const skillsRepo = yield* SkillsRepo;
  const entries = yield* store.listSubtreeBlobs(
    input.storePath,
    input.headSha,
    ADOPTION_SKILLS_DIR,
    MAX_ADOPTION_SKILL_BLOBS,
  );
  const candidates = selectAdoptedSkillFiles(entries);
  if (candidates.length === 0) return 0;

  const loaded = yield* Effect.forEach(
    candidates,
    (candidate) =>
      Effect.gen(function* () {
        const readFiles = yield* Effect.forEach(
          candidate.files,
          (file) =>
            store
              .readBlob(input.storePath, input.headSha, file.repoPath, SKILL_MAX_FILE_BYTES + 1)
              .pipe(
                Effect.map((blob) => {
                  if (blob === null || blob.truncated || blob.binary) return null;
                  return {
                    path: file.skillPath,
                    contents: utf8Decoder.decode(blob.bytes),
                  };
                }),
              ),
          // Bounded concurrency: each read spawns `git cat-file` against the local bare repo.
          { concurrency: BLOB_READ_CONCURRENCY },
        );
        const files = readFiles.filter(
          (file): file is { readonly path: string; readonly contents: string } => file !== null,
        );
        const entryFile = files.find((file) => file.path === SKILL_ENTRY_FILE);
        if (entryFile === undefined) return null;
        const bundle: SkillBundleInput = {
          name: candidate.name,
          description: readSkillFrontmatterDescription(entryFile.contents),
          files,
        };
        return validateSkillBundle(bundle) === null ? bundle : null;
      }),
    { concurrency: 1 },
  );

  const bundles = loaded.filter((bundle): bundle is SkillBundleInput => bundle !== null);
  if (bundles.length === 0) return 0;
  const report = yield* skillsRepo.sync({ scope: "project", projectId: input.projectId }, bundles, {
    prune: false,
  });
  return report.created.length + report.updated.length;
});
