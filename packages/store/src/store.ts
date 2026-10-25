import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Sha } from "@mend/domain";
import { RepositoryCloneUrl, redactRepositoryUrl } from "@mend/domain/workbench";
import { Clock, Effect, Fiber, Layer, Result, Schema, type Scope } from "effect";
import * as Context from "effect/Context";

import { noSignerGitEnv } from "./git-auth.ts";
import {
  type CappedBytes,
  git,
  gitCapped,
  gitCappedBytes,
  gitCommitOf,
  GitError,
  gitHead,
} from "./git.ts";
import {
  type AdmittedHandoff,
  type AdmitHandoffOptions,
  admitHandoff as admitHandoffIn,
  failedFreshen,
  fetchedFreshen,
  type FreshenOutcome,
  type HandoffFileOverBudgetError,
  type HandoffRefusedError,
  skippedFreshen,
  sweepHandoffQuarantines as sweepQuarantinesUnder,
} from "./handoff.ts";
import {
  type BundleEmptyError,
  type BundleInput,
  type BundleTooLargeError,
  type ChangeBundle,
  createChangeBundle,
  type InvalidBranchError,
  landedRefOf,
  type LandingCommit,
  type LandingCommitInput,
  type ProbeInput,
  probeRemoteBranch,
  pushBranch,
  type PushInput,
  type Pushed,
  type PushRefusedError,
  type RemoteBranchState,
  writeLandingCommit,
} from "./landing.ts";
import { mendHome } from "./paths.ts";
import {
  RawReadError,
  type OpenRawFile,
  readRawDescriptor,
  revisionFingerprint,
} from "./raw-file.ts";
import { refuseRemoteCredentials } from "./remote-credentials.ts";
import { gitRemoteEnvironment, type GitRemoteEnvironment } from "./remote-operation-env.ts";

/** Where the store lives on disk. One root, one directory per project. */
export class StoreConfig extends Context.Service<
  StoreConfig,
  {
    readonly root: string;
  }
>()("@mend/store/StoreConfig") {
  static readonly layer = Layer.effect(
    StoreConfig,
    Effect.sync(() => ({
      root: process.env["MEND_STORE_ROOT"] ?? path.join(mendHome(), "store"),
    })),
  );
  static readonly layerFor = (root: string) => Layer.succeed(StoreConfig, { root });
}

/** Where an organization's reference clone lives, relative to the store root. */
export const referenceDirectory = (organizationId: string, referenceId: string): string =>
  path.join("_organizations", organizationId, "references", referenceId);

/** What Mend says of a shallow repository, at adoption and at a session's start. */
export const SHALLOW_REPOSITORY_REASON =
  "Mend doesn't support shallow repositories yet. Make the repository complete where it is hosted (`git fetch --unshallow`), then adopt it again.";

/** What Mend says of a repository with grafts, at adoption and at a session's start. */
export const GRAFTED_REPOSITORY_REASON =
  "Mend doesn't support repositories with grafts (`info/grafts`) yet. Remove the grafts, or convert them with `git replace --convert-graft-file`.";

/**
 * Whether the grafts file at `file` names any commit: a line that is neither blank nor `#`. One
 * that is absent or cannot be read names none here; git reading it fails on its own.
 */
const graftsNameCommits = (file: string): boolean => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  } catch {
    return false;
  }
};

/**
 * Why Mend refuses the repository at `gitDir`, or null (owner, 2026-09-28; e2e8 (d)): SHA-256
 * objects, shallow history, or grafts. A SHA-256 session does not survive its capture and restore
 * end to end yet. A shallow one cannot be saved: the base pack Mend makes stops at the shallow
 * boundary, and the closure walk that verifies a capture (`CaptureGitVerifier`) reads the boundary
 * commits' parents, which nothing holds, so every save's git section fails and its final seal is
 * refused (verify proof run 9, 2026-10-10). The store is a full clone of its source, so a shallow
 * store means a shallow source: nothing fetched from it deepens the history. Grafts
 * (`info/grafts`, which a clone never copies, so only a store edited on the host has them) cut the
 * base pack the same way while git calls the repository complete (Astra review of mend#654).
 * Replace refs do not: `pack-objects` ignores them, and the pack holds the real closure. Such a
 * project is refused when it is adopted and when a session starts on it, rather than started and
 * left unable to save. Read through git itself (`rev-parse`, one run). The reason is the sentence
 * a person reads.
 */
export const unsupportedRepositoryReason = (
  gitDir: string,
): Effect.Effect<string | null, GitError> =>
  Effect.flatMap(
    git(
      ["rev-parse", "--show-object-format", "--is-shallow-repository", "--git-path", "info/grafts"],
      gitDir,
    ),
    (out) => {
      const [objectFormat = "", shallow = "", grafts = ""] = out.trim().split("\n");
      if (objectFormat !== "sha1") {
        return Effect.succeed(
          objectFormat === "sha256"
            ? "Mend doesn't support SHA-256 repositories yet."
            : `Mend doesn't support ${objectFormat} repositories yet.`,
        );
      }
      if (shallow.trim() === "true") return Effect.succeed(SHALLOW_REPOSITORY_REASON);
      return Effect.sync(() =>
        grafts.trim() !== "" && graftsNameCommits(path.resolve(gitDir, grafts.trim()))
          ? GRAFTED_REPOSITORY_REASON
          : null,
      );
    },
  );

/** `unsupportedRepositoryReason` as a refusal: a `GitError` whose `stderr` is the reason. */
export const refuseUnsupportedRepository = (gitDir: string): Effect.Effect<void, GitError> =>
  Effect.flatMap(unsupportedRepositoryReason(gitDir), (reason) =>
    reason === null
      ? Effect.void
      : Effect.fail(
          new GitError({
            args: ["mend", "repository-format"],
            cwd: gitDir,
            exitCode: null,
            stderr: reason,
          }),
        ),
  );

export class AdoptError extends Schema.TaggedError<AdoptError>()("AdoptError", {
  directory: Schema.String,
  source: RepositoryCloneUrl,
  cause: GitError,
}) {}

/** Named to dodge the JS global `ReferenceError`; same shape as `AdoptError`. */
export class ReferenceCloneError extends Schema.TaggedError<ReferenceCloneError>()(
  "ReferenceCloneError",
  {
    name: Schema.String,
    source: Schema.String,
    cause: GitError,
  },
) {}

export interface ReferenceClone {
  /** Absolute path of the working clone: `<root>/_organizations/<org>/references/<id>`. */
  readonly path: string;
  readonly headSha: Sha;
}

export interface AdoptedRepo {
  /** Absolute path of the bare repo: `<root>/<name>/repo.git`. */
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly headSha: Sha;
}

/** Landing's commit in the project store: no branch moves, the worktree does not either. */
export interface StoreLandingCommitInput extends LandingCommitInput {
  /**
   * The worktree whose `refs/mend/landed/<id>` keeps the landed head reachable for later
   * landings, probes and bundles. Null keeps nothing: a bundle's commit lives only in the bundle.
   */
  readonly keepFor: string | null;
}

/** A flat, sorted path list — the client nests it; `truncated` when the cap bit. */
export interface FileListing {
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface SessionWorktree {
  /** Absolute path of the worktree directory. */
  readonly path: string;
  /** Directory name inside `<root>/<name>/worktrees/`. */
  readonly name: string;
  readonly branch: string;
  readonly baseSha: Sha;
  /** The base as resolved — the caller's ref, or the default branch when none was given. */
  readonly baseRef: string;
}

/** One branch the store can base a session on, as `listBranches` reports it. */
export interface StoreBranch {
  /** Short branch name (`main`, `yiannisp/refactor`) — never a session branch. */
  readonly name: string;
  readonly sha: Sha;
  /** Committer date of the tip, ISO 8601. */
  readonly committedAt: string;
  readonly isDefault: boolean;
}

export interface CheckpointSnapshot {
  readonly ref: string;
  readonly sha: Sha;
  /** Capture mode: the registered capture the snapshot came from (or was derived from). */
  readonly captureId?: string | undefined;
}

export interface ChangedFile {
  /** Actual filename, using the destination for a rename/copy and source for deletion. */
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown";

/** The start of one file's bytes: at most what was asked, and how large the file is. */
export interface FileRead {
  readonly bytes: Uint8Array;
  /** The whole file's size in bytes. */
  readonly size: number;
  /** Fewer bytes than the file holds were read. */
  readonly truncated: boolean;
  /** A NUL in the first 8000 bytes, as git decides it. */
  readonly binary: boolean;
}

/** What `grep` looks for: literal text unless `regex`, whole words when asked. */
export interface GrepQuery {
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

/** One line that matched. */
export interface GrepMatch {
  readonly path: string;
  /** From 1. */
  readonly line: number;
  readonly text: string;
}

export interface GrepResult {
  readonly matches: ReadonlyArray<GrepMatch>;
  /** More lines matched than were kept. */
  readonly truncated: boolean;
}

/**
 * A path inside a worktree as a client may name one: relative, without `..` or an empty segment,
 * and never into `.git`.
 */
export const isWorktreeRelativePath = (relative: string): boolean => {
  if (relative.length === 0 || relative.includes("\0") || path.isAbsolute(relative)) return false;
  const segments = relative.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment !== ".git",
  );
};

const binaryOf = (bytes: Uint8Array): boolean => bytes.subarray(0, 8000).includes(0);

/** How many links one read follows inside a worktree before it gives up. */
const CONTAINED_LINK_HOPS = 16;
const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
/** What a missing, swapped or refused entry answers: nothing to read, never an error. */
const GONE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "ENXIO"]);

/**
 * The first of `/proc/self/fd/` and `/dev/fd/` through which `<base><fd>/.` is the directory `fd`
 * holds (same device and inode), so a path under it reaches that directory whatever its name is
 * now; null when neither does (no `/proc`; macOS's `/dev/fd` opens a descriptor, it does not walk
 * into one). The probe mend#615's contained writer uses.
 */
const descriptorDirectory = (fd: number): string | null => {
  const held = fs.fstatSync(fd);
  for (const base of ["/proc/self/fd/", "/dev/fd/"]) {
    try {
      const seen = fs.statSync(`${base}${fd}/.`);
      if (seen.dev === held.dev && seen.ino === held.ino) return base;
    } catch {
      // Not here.
    }
  }
  return null;
};

/** Where no descriptor can be walked into, a read is refused rather than walked by its path. */
export const containmentUnavailable = (root: string): string =>
  `no /proc/self/fd or /dev/fd here to keep the read inside ${root}`;

/** A file opened inside a worktree, and the descriptor directory it was reached through. */
interface ContainedFile {
  readonly fd: number;
  readonly base: string;
}

/**
 * Opens `<root>/<relative>` for reading so that nothing outside `root` can be what is opened, even
 * while the worktree changes underneath (mend#602 review, 602-1 and 602-R2-1; the walk mend#615's
 * contained writer uses). Each directory is opened through no link (`O_NOFOLLOW`), the next one
 * through the last one's descriptor (`/proc/self/fd/<n>/…`, or `/dev/fd/<n>/…` where a probe shows
 * it walks), and the file through no link either. Never by its literal path: a directory renamed
 * and replaced by a link mid-walk is then not on the way. Where no descriptor directory walks, the
 * read is refused (an error), never walked by path. A link met on the way is read and the walk
 * starts again from `root` on its target, only while that target stays inside `root` and `.git` is
 * not on it. Null when there is nothing (left) to read there.
 */
const openContained = (root: string, relative: string): ContainedFile | null => {
  const c = fs.constants;
  const enter = c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW;
  let parts = relative.split("/");
  for (let hops = 0; hops <= CONTAINED_LINK_HOPS; hops++) {
    let dfd: number;
    try {
      dfd = fs.openSync(root, enter);
    } catch (error) {
      if (GONE.has(errorCode(error) ?? "")) return null;
      throw error;
    }
    const walked: Array<string> = [];
    let restart: Array<string> | null = null;
    try {
      const base = descriptorDirectory(dfd);
      if (base === null) throw new Error(containmentUnavailable(root));
      for (const [index, part] of parts.entries()) {
        if (part === ".git") return null;
        const at = `${base}${dfd}/${part}`;
        const entry = fs.lstatSync(at, { throwIfNoEntry: false });
        if (entry === undefined) return null;
        if (entry.isSymbolicLink()) {
          const target = fs.readlinkSync(at);
          const joined = path.posix.isAbsolute(target)
            ? target.startsWith(`${root}/`)
              ? target.slice(root.length + 1)
              : null
            : path.posix.normalize(path.posix.join(...walked, target));
          if (joined === null || joined === ".." || joined.startsWith("../")) return null;
          restart = [...joined.split("/"), ...parts.slice(index + 1)].filter(
            (segment) => segment !== "" && segment !== ".",
          );
          break;
        }
        if (index === parts.length - 1) {
          // No link, and no waiting on a pipe: a file, or nothing.
          return { fd: fs.openSync(at, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK), base };
        }
        const next = fs.openSync(at, enter);
        fs.closeSync(dfd);
        dfd = next;
        walked.push(part);
      }
    } catch (error) {
      if (GONE.has(errorCode(error) ?? "")) return null;
      throw error;
    } finally {
      fs.closeSync(dfd);
    }
    if (restart === null || restart.length === 0) return null;
    parts = restart;
  }
  return null;
};

/**
 * Whether an opened file is inside `root` and outside `.git`, by where the descriptor itself is
 * (its link under the descriptor directory it was reached through), not by the path that named
 * it. A descriptor whose place cannot be read is not inside.
 */
const descriptorInside = (file: ContainedFile, root: string): boolean => {
  let real: string;
  try {
    real = fs.readlinkSync(`${file.base}${file.fd}`);
  } catch {
    return false;
  }
  return real.startsWith(`${root}${path.sep}`) && !real.split(path.sep).includes(".git");
};

const validRawPath = (value: string) =>
  isWorktreeRelativePath(value) && !value.includes("\\") && Buffer.byteLength(value) <= 4096;

const openRawWorktreeFile = (
  worktreePath: string,
  relative: string,
  within: string,
): Effect.Effect<OpenRawFile, RawReadError, Scope.Scope> =>
  Effect.gen(function* () {
    const inside = (name: string) => within === "" || name.startsWith(`${within}/`);
    if (!validRawPath(relative) || (within !== "" && !validRawPath(within)) || !inside(relative)) {
      return yield* new RawReadError({ reason: "missing" });
    }
    const opened = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const root = fs.realpathSync(worktreePath);
          return { root, file: openContained(root, relative) };
        },
        catch: () => new RawReadError({ reason: "missing" }),
      }),
      ({ file }) =>
        Effect.sync(() => {
          if (file !== null) fs.closeSync(file.fd);
        }),
    );
    const { file, root } = opened;
    if (file === null) return yield* new RawReadError({ reason: "missing" });
    const metadata = yield* Effect.try({
      try: () => ({
        stat: fs.fstatSync(file.fd, { bigint: true }),
        descriptorPath: fs.readlinkSync(`${file.base}${file.fd}`),
      }),
      catch: () => new RawReadError({ reason: "missing" }),
    });
    const { stat, descriptorPath } = metadata;
    const canonicalPath = descriptorPath.slice(root.length + 1);
    if (
      !stat.isFile() ||
      !descriptorPath.startsWith(`${root}${path.sep}`) ||
      !validRawPath(canonicalPath) ||
      !inside(canonicalPath)
    ) {
      return yield* new RawReadError({ reason: "missing" });
    }
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      return yield* new RawReadError({ reason: "too-large" });
    const size = Number(stat.size);
    const revision = revisionFingerprint({
      kind: "disk",
      fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    });
    return {
      canonicalPath,
      size,
      revision,
      identity: createHash("sha256").update(`${stat.dev}:${stat.ino}`).digest("hex"),
      read: readRawDescriptor(file.fd, size),
    };
  });

/** How much of one matching line a search answers: enough to show it, never a whole blob. */
export const GREP_LINE_LIMIT = 2_000;
/** How much of git's output one search reads before it stops git. */
export const GREP_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How long one search may run before git is stopped and what it found answers. */
export const GREP_DEADLINE_MS = 10_000;

/**
 * `git grep -n -z` output (`path\0line\0text`, paths prefixed by `rev:` for a tree) as matches, at
 * most `limit`, each line's text cut at `GREP_LINE_LIMIT`. Output git was stopped in (`cut`) ends
 * in a part record: kept when its path and line came through, its text cut; else dropped. Stopped
 * output, or more matches than `limit`, says `truncated`; a line cut to its limit does not.
 */
export const parseGrep = (
  out: string,
  rev: string | null,
  limit: number,
  cut = false,
): GrepResult => {
  const matches: Array<GrepMatch> = [];
  let truncated = cut;
  const records = out.split("\n");
  for (const [index, record] of records.entries()) {
    if (record.length === 0) continue;
    const fields = record.split("\0");
    if (cut && index === records.length - 1 && fields.length < 3) break;
    const [rawPath = "", line = "", ...rest] = fields;
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    const prefix = rev === null ? "" : `${rev}:`;
    const text = rest.join("\0");
    matches.push({
      path: rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath,
      line: Number.parseInt(line, 10),
      text: text.length > GREP_LINE_LIMIT ? text.slice(0, GREP_LINE_LIMIT) : text,
    });
  }
  return { matches, truncated };
};

/** Git facts for one file in an immutable commit range. */
/**
 * How a range is rendered (`Store.diffRange`). `paths` keeps only those files (literal paths; a
 * rename's both sides); `maxBytes` stops at that many bytes and keeps only the files rendered whole,
 * so a caller compares the files it got with those it asked for.
 */
export interface DiffRangeOptions {
  readonly ignoreWhitespace?: boolean;
  readonly contextLines?: number;
  readonly paths?: ReadonlyArray<string>;
  readonly maxBytes?: number;
}

/** A bounded listing of a range's files: what git listed within the budget. */
export interface DiffFileFactsOptions {
  readonly ignoreWhitespace?: boolean;
  /** Only these paths, taken literally: git lists nothing else. */
  readonly paths?: ReadonlyArray<string>;
  /** How much of each of git's two listings is read; past it the listing is cut. */
  readonly maxBytes: number;
  /** Past this, git is stopped and what it listed answers, cut. */
  readonly deadlineMs?: number;
  /**
   * With `deadlineMs`: a listing the deadline cuts answers at least this many of the range's
   * first files, as many as it has within the deadline. Git prints a range's files only once it
   * has walked the whole range, so a deadline that stops it mid-walk leaves nothing listed: the
   * first files are found beside it, one directory at a time, and listed by path within the same
   * deadline. A rename whose other side lies past those files is the addition or deletion it is
   * in tree order: pairing it takes the walk the deadline cut.
   */
  readonly minFiles?: number;
}

export interface DiffFileFactsListing {
  /** The range's first files, in git's order: all of them unless `cut`. */
  readonly facts: ReadonlyArray<DiffFileFact>;
  /** Git listed more than the budget or the deadline let through. */
  readonly cut: boolean;
}

export interface DiffFileFact {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

interface NumstatEntry {
  /** Actual destination name from -z, or the source name for a deletion. */
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

const statusOf = (token: string): DiffFileStatus => {
  switch (token[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
};

const parseNumstat = (raw: string): ReadonlyArray<NumstatEntry> => {
  const entries: Array<NumstatEntry> = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const firstTab = raw.indexOf("\t", cursor);
    const secondTab = raw.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) break;
    const added = raw.slice(cursor, firstTab);
    const deleted = raw.slice(firstTab + 1, secondTab);
    cursor = secondTab + 1;
    let file: string;
    if (raw[cursor] === "\0") {
      // Renames/copies use an empty path field, then old\0new\0, never display braces.
      const oldEnd = raw.indexOf("\0", cursor + 1);
      const newEnd = oldEnd < 0 ? -1 : raw.indexOf("\0", oldEnd + 1);
      if (newEnd < 0) break;
      file = raw.slice(oldEnd + 1, newEnd);
      cursor = newEnd + 1;
    } else {
      const terminator = raw.indexOf("\0", cursor);
      if (terminator < 0) break;
      file = raw.slice(cursor, terminator);
      cursor = terminator + 1;
    }
    entries.push({
      path: file,
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
      binary: added === "-" || deleted === "-",
    });
  }
  return entries;
};

const parseNameStatus = (
  raw: string,
  numstat: ReadonlyArray<NumstatEntry>,
): ReadonlyArray<DiffFileFact> => {
  const tokens = raw.split("\0");
  const files: Array<DiffFileFact> = [];
  let cursor = 0;
  while (cursor < tokens.length && tokens[cursor] !== "") {
    const statusToken = tokens[cursor++] ?? "";
    const status = statusOf(statusToken);
    const firstPath = tokens[cursor++] ?? "";
    const hasTwoPaths = status === "renamed" || status === "copied";
    const secondPath = hasTwoPaths ? (tokens[cursor++] ?? "") : firstPath;
    const counts = numstat[files.length] ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      oldPath: status === "added" ? null : firstPath,
      newPath: status === "deleted" ? null : secondPath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      binary: counts.binary,
    });
  }
  return files;
};

/** A `--name-status -z` record: what happened to a file, and its paths. */
interface NameStatusRecord {
  readonly status: DiffFileStatus;
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

/**
 * `--name-status -z` records whose every part git ended with a NUL: output cut short (a byte cap,
 * a deadline) loses its half record, never reads one as whole.
 */
const nameStatusRecords = (raw: string): ReadonlyArray<NameStatusRecord> => {
  const tokens = raw.split("\0");
  // Every token but the last was ended by a NUL.
  const ended = tokens.length - 1;
  const records: Array<NameStatusRecord> = [];
  let cursor = 0;
  while (cursor < ended && tokens[cursor] !== "") {
    const status = statusOf(tokens[cursor] ?? "");
    const twoPaths = status === "renamed" || status === "copied";
    const width = twoPaths ? 3 : 2;
    if (cursor + width > ended) break;
    const first = tokens[cursor + 1] ?? "";
    const second = twoPaths ? (tokens[cursor + 2] ?? "") : first;
    records.push({
      status,
      oldPath: status === "added" ? null : first,
      newPath: status === "deleted" ? null : second,
    });
    cursor += width;
  }
  return records;
};

/** A `--numstat -z` record: a file's counts, under its new path (a deleted file's old one). */
interface NumstatRecord extends NumstatEntry {
  readonly path: string;
}

/** `--numstat -z` records git ended, as `nameStatusRecords` takes them. */
const numstatRecords = (raw: string): ReadonlyArray<NumstatRecord> => {
  const records: Array<NumstatRecord> = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const firstTab = raw.indexOf("\t", cursor);
    const secondTab = firstTab < 0 ? -1 : raw.indexOf("\t", firstTab + 1);
    if (secondTab < 0) break;
    const added = raw.slice(cursor, firstTab);
    const deleted = raw.slice(firstTab + 1, secondTab);
    let next = secondTab + 1;
    let at: string;
    if (raw[next] === "\0") {
      // A rename or copy: `\0old\0new\0`.
      const oldEnd = raw.indexOf("\0", next + 1);
      const newEnd = oldEnd < 0 ? -1 : raw.indexOf("\0", oldEnd + 1);
      if (newEnd < 0) break;
      at = raw.slice(oldEnd + 1, newEnd);
      next = newEnd + 1;
    } else {
      const end = raw.indexOf("\0", next);
      if (end < 0) break;
      at = raw.slice(next, end);
      next = end + 1;
    }
    records.push({
      path: at,
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
      binary: added === "-" || deleted === "-",
    });
    cursor = next;
  }
  return records;
};

/** One entry of a directory as it stands on each side of a range: a tree, a file, or absent. */
interface TreeLevelEntry {
  /** The name as git wrote it: bytes, since a name need not be UTF-8. */
  readonly name: Buffer;
  readonly oldTree: string | null;
  readonly newTree: string | null;
  /** The entry is a file (a blob, a symlink or a gitlink) on at least one side. */
  readonly file: boolean;
}

const TREE_MODE = "040000";
const ABSENT_MODE = "000000";

/** The NUL-ended fields of git's `-z` output; a field the output ends without (cut short) is dropped. */
const nulFields = (raw: Buffer): ReadonlyArray<Buffer> => {
  const fields: Array<Buffer> = [];
  let start = 0;
  for (let end = raw.indexOf(0, start); end >= 0; end = raw.indexOf(0, start)) {
    fields.push(raw.subarray(start, end));
    start = end + 1;
  }
  return fields;
};

/**
 * `diff-tree --raw -z` records of one directory compared across a range, without recursing:
 * `:<old mode> <new mode> <old sha> <new sha> <status>\0<name>\0`.
 */
const rawDiffEntries = (raw: Buffer): ReadonlyArray<TreeLevelEntry> => {
  const fields = nulFields(raw);
  const entries: Array<TreeLevelEntry> = [];
  for (let cursor = 0; cursor + 1 < fields.length; cursor += 2) {
    const [oldMode, newMode, oldSha, newSha] = (fields[cursor] ?? Buffer.alloc(0))
      .toString("latin1")
      .slice(1)
      .split(" ");
    if (oldMode === undefined || newMode === undefined || newSha === undefined) break;
    if (oldSha === undefined) break;
    entries.push({
      name: fields[cursor + 1] ?? Buffer.alloc(0),
      oldTree: oldMode === TREE_MODE ? oldSha : null,
      newTree: newMode === TREE_MODE ? newSha : null,
      file:
        (oldMode !== TREE_MODE && oldMode !== ABSENT_MODE) ||
        (newMode !== TREE_MODE && newMode !== ABSENT_MODE),
    });
  }
  return entries;
};

/**
 * `ls-tree -z` records of one directory that is on one side of a range only, so every entry is
 * added (`side: "new"`) or deleted: `<mode> <type> <sha>\t<name>\0`.
 */
const lsTreeEntries = (raw: Buffer, side: "old" | "new"): ReadonlyArray<TreeLevelEntry> => {
  const entries: Array<TreeLevelEntry> = [];
  for (const field of nulFields(raw)) {
    const tab = field.indexOf(9);
    if (tab < 0) break;
    const [mode, , sha] = field.subarray(0, tab).toString("latin1").split(" ");
    if (mode === undefined || sha === undefined) break;
    const tree = mode === TREE_MODE ? sha : null;
    entries.push({
      name: field.subarray(tab + 1),
      oldTree: side === "old" ? tree : null,
      newTree: side === "new" ? tree : null,
      file: tree === null,
    });
  }
  return entries;
};

/** A git run under the budget left to the operation that asks for it. */
type CappedRun = (args: ReadonlyArray<string>) => Effect.Effect<CappedBytes, GitError>;

/** One pathspec of a floor: a file, or a directory the walk took whole (every file below it). */
interface SelectedPath {
  readonly path: Buffer;
  readonly whole: boolean;
}

/**
 * The first files of a range, as pathspecs: `complete` when they cover all of its files, `cut`
 * when a directory read was cut short (past the budget, or the bytes), so no wider walk helps.
 */
interface Selection {
  readonly items: ReadonlyArray<SelectedPath>;
  readonly complete: boolean;
  readonly cut: boolean;
}

const SLASH = Buffer.from("/");

/**
 * The first `limit` files of the range `a..b`, in git's order (a directory's entries by name,
 * each directory's files before the next entry), found one directory at a time: a directory on
 * both sides is compared without recursing (`diff-tree`), one on a single side is read
 * (`ls-tree`). Each read is one directory, so the first files cost their depth in reads however
 * wide the range is. A directory the walk took whole is selected as one pathspec, so a wide floor
 * stays a short command line; the files of the directory it stopped in are selected one by one.
 * A directory read cut short (past the budget, or the bytes) leaves the selection incomplete.
 * Renames are not paired: a moved file is its old path and its new one.
 */
const firstChangedPaths = (
  a: string,
  b: string,
  limit: number,
  run: CappedRun,
): Effect.Effect<Selection, GitError> =>
  Effect.gen(function* () {
    const items: Array<SelectedPath> = [];
    let files = 0;
    let complete = true;
    let cut = false;
    const read = (oldTree: string | null, newTree: string | null) =>
      Effect.gen(function* () {
        if (oldTree === null && newTree === null) return [];
        const listed = yield* run(
          oldTree !== null && newTree !== null
            ? ["diff-tree", "--raw", "-z", "--no-renames", oldTree, newTree]
            : ["ls-tree", "-z", newTree ?? oldTree ?? ""],
        );
        if (listed.cut) {
          complete = false;
          cut = true;
        }
        return oldTree !== null && newTree !== null
          ? rawDiffEntries(listed.stdout)
          : lsTreeEntries(listed.stdout, newTree !== null ? "new" : "old");
      });
    /** Walks one directory; true when every entry below it was taken. */
    const level = (
      prefix: Buffer,
      oldTree: string | null,
      newTree: string | null,
    ): Effect.Effect<boolean, GitError> =>
      Effect.gen(function* () {
        const entries = yield* read(oldTree, newTree);
        for (const entry of entries) {
          if (files >= limit) {
            complete = false;
            return false;
          }
          const at = Buffer.concat([prefix, entry.name]);
          // Git orders a file before a directory of the same name, whichever side has which.
          if (entry.file) {
            items.push({ path: at, whole: false });
            files += 1;
          }
          if (entry.oldTree !== null || entry.newTree !== null) {
            const mark = items.length;
            const whole = yield* level(Buffer.concat([at, SLASH]), entry.oldTree, entry.newTree);
            if (!whole) return false;
            items.splice(mark, items.length - mark, { path: at, whole: true });
          }
        }
        return complete;
      });
    yield* level(Buffer.alloc(0), a, b);
    return { items, complete, cut };
  });

/** What a floor's pathspecs may add up to: well inside every platform's argument limit. */
const SELECTION_BYTES = 256 * 1024;

/** A valid UTF-8 character at `at`, as its byte length, or 0 where the bytes are not one. */
const utf8Length = (bytes: Buffer, at: number): number => {
  const lead = bytes[at] ?? 0;
  const length =
    lead < 0x80 ? 1 : lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0;
  if (length === 0 || at + length > bytes.length) return 0;
  const sequence = bytes.subarray(at, at + length);
  return Buffer.from(sequence.toString("utf8"), "utf8").equals(sequence) ? length : 0;
};

const GLOB_META = new Set(["\\", "*", "?", "[", "]"]);

/**
 * `path` as pathspecs git takes literally. A name of valid UTF-8 is `:(literal)` itself. A
 * name with other bytes cannot be an argument (a string carries only UTF-8), so it is a
 * `:(glob)` with `?` for each such byte (wildmatch matches bytes), its wildcards escaped; the
 * listing is then filtered to the names selected, in case the glob matched a sibling too.
 * A directory taken whole matches as its own name and as everything below it.
 */
const pathspecsOf = ({ path: name, whole }: SelectedPath): ReadonlyArray<string> => {
  const text = name.toString("utf8");
  if (Buffer.from(text, "utf8").equals(name)) {
    return [`:(literal)${text}`];
  }
  let glob = "";
  for (let at = 0; at < name.length; ) {
    const length = utf8Length(name, at);
    if (length === 0) {
      glob += "?";
      at += 1;
      continue;
    }
    const character = name.subarray(at, at + length).toString("utf8");
    glob += GLOB_META.has(character) ? `\\${character}` : character;
    at += length;
  }
  return whole ? [`:(glob)${glob}`, `:(glob)${glob}/**`] : [`:(glob)${glob}`];
};

/** The paths of each `--name-status -z` record, as git wrote them: bytes, for an exact match. */
const rawNameStatusPaths = (
  raw: Buffer,
): ReadonlyArray<{ readonly oldPath: Buffer | null; readonly newPath: Buffer | null }> => {
  const fields = nulFields(raw);
  const records: Array<{ oldPath: Buffer | null; newPath: Buffer | null }> = [];
  let cursor = 0;
  while (cursor < fields.length && (fields[cursor]?.length ?? 0) > 0) {
    const status = statusOf(fields[cursor]?.toString("latin1") ?? "");
    const width = status === "renamed" || status === "copied" ? 3 : 2;
    if (cursor + width > fields.length) break;
    const first = fields[cursor + 1] ?? Buffer.alloc(0);
    const second = width === 3 ? (fields[cursor + 2] ?? Buffer.alloc(0)) : first;
    records.push({
      oldPath: status === "added" ? null : first,
      newPath: status === "deleted" ? null : second,
    });
    cursor += width;
  }
  return records;
};

/** Whether a listed path, as git wrote it, is one the selection asked for: the same bytes. */
const selectedBy =
  (items: ReadonlyArray<SelectedPath>) =>
  (listed: Buffer | null): boolean =>
    listed !== null &&
    items.some(
      ({ path: name, whole }) =>
        listed.equals(name) ||
        (whole &&
          listed.length > name.length &&
          listed.subarray(0, name.length).equals(name) &&
          listed[name.length] === SLASH[0]),
    );

const sha = (value: string) => Sha.make(value);

const commitOf = (storePath: string, ref: string) =>
  git(["rev-parse", `${ref}^{commit}`], storePath);

const knownBaseSha = (storePath: string, baseRef: string) =>
  commitOf(storePath, `refs/remotes/origin/${baseRef}`).pipe(
    Effect.catch(() => commitOf(storePath, baseRef)),
  );

/**
 * Every session branch Mend makes (`mend/<name>`, `mend/wt/<id>`, `mend/session/<id>`), and the
 * name a landing pushes one under on origin (docs/adr/0007-landing.md).
 */
const SESSION_BRANCHES = "refs/heads/mend/*";

/** A short branch name that is one of Mend's session branches, or a landed one. */
export const isSessionBranch = (name: string): boolean => name.startsWith("mend/");

/**
 * Make one tree group-writable with setgid directories — the filesystem half of
 * `core.sharedRepository=group`. Entries another uid owns are skipped silently: chmod is the
 * owner's privilege, and the policy exists precisely so future writes stop needing this.
 */
const shareTree = (root: string): void => {
  const stack: Array<string> = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    try {
      fs.chmodSync(dir, (fs.statSync(dir).mode & 0o7777) | 0o2070);
    } catch {
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile()) {
        try {
          fs.chmodSync(target, (fs.statSync(target).mode & 0o7777) | 0o060);
        } catch {
          // Another uid's file — covered by the policy from here on.
        }
      }
    }
  }
};

/** Untracked paths — invisible to `git diff <base>` but part of the change. */
const untrackedIn = (worktreePath: string) =>
  git(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath).pipe(
    Effect.map((out) => out.split("\0").filter((name) => name !== "")),
  );

const capListing = (paths: ReadonlyArray<string>, limit: number): FileListing => {
  const sorted = paths.filter((entry) => entry !== "").toSorted();
  return { files: sorted.slice(0, limit), truncated: sorted.length > limit };
};

const rmBestEffort = (target: string): { readonly leftover: string | null } => {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // EACCES on container-uid files — what survives is reported by the caller.
  }
  return { leftover: fs.existsSync(target) ? target : null };
};

/** Where a named worktree lives relative to its project's bare repo. */
export const worktreePathOf = (storePath: string, name: string) =>
  path.join(worktreesRootOf(storePath), name);

/**
 * The project's worktrees directory — the ROOT a standby workspace mounts (ADR-0001): every
 * worktree of the project sits directly under it, and the workspace binds one at claim.
 */
export const worktreesRootOf = (storePath: string) =>
  path.join(path.dirname(storePath), "worktrees");

/**
 * Where a session's harvested harness state lives (plan: the session store).
 * Holds the raw native state tarball, the primary transcript, and the
 * manifest — written automatically at settle, read automatically at relaunch.
 */
export const sessionStatePathOf = (storePath: string, sessionId: string) =>
  path.join(path.dirname(storePath), "sessions", sessionId);

/**
 * Where ONE agent process's harvested harness state lives — harness state is per agent
 * process, not per session (a session holds several over its life). Older sessions kept it at
 * the session root; readers fall back there.
 */
export const processStatePathOf = (storePath: string, sessionId: string, processId: string) =>
  path.join(sessionStatePathOf(storePath, sessionId), "processes", processId);

/**
 * Where a session's LIVE harness home lives: the durable backing directory mounted read-write
 * into every workspace of the session, holding the harness state dirs (`.claude`, `.codex`, …)
 * that the workspace symlinks into `$HOME` at boot. State written here survives any workspace
 * death — harvest-at-settle reads it, and a relaunch after a crash resumes from it. It is also
 * the server-side seam for managing what a harness sees in `$HOME` (skills, settings) without
 * a workspace exec.
 */
export const harnessHomePathOf = (storePath: string, sessionId: string) =>
  path.join(sessionStatePathOf(storePath, sessionId), "harness-home");

/**
 * The central repository store (plan §5.2, §8.1.A): bare clone per project,
 * one git worktree per session, checkpoints as commits on hidden refs that
 * never touch the visible branch. Everything here is host-side plain git —
 * no Sealant dependency; workspaces mount the worktrees this service creates.
 */
export class Store extends Context.Service<
  Store,
  {
    /**
     * Clone a parsed network Git `source` into the store as a bare repo.
     * `remoteEnv` carries the resolved auth (`GIT_SSH_COMMAND`, prompt policy)
     * from the git-auth seam — the store itself never decides credentials. `directory` is the
     * store path segment: the project id for projects adopted after organizations, because names
     * are unique only within an organization (docs/adr/0003-organizations-and-tenancy.md).
     */
    readonly adopt: (
      directory: string,
      source: RepositoryCloneUrl,
      remoteEnv: GitRemoteEnvironment,
    ) => Effect.Effect<AdoptedRepo, AdoptError>;
    /**
     * Create a worktree on its own branch from `base` (default branch when null). The caller
     * owns identity: `directory` under the store's `worktrees/` parent and the full `branch`
     * name. `remoteEnv` freshens the base from origin first — best-effort, so an unreachable
     * remote costs currency, never the session; null skips the fetch (caller had no credentials).
     */
    readonly createWorktree: (
      storePath: string,
      identity: { readonly directory: string; readonly branch: string },
      base: string | null,
      remoteEnv: GitRemoteEnvironment | null,
    ) => Effect.Effect<SessionWorktree, GitError>;
    /**
     * The base a new worktree starts from, resolved the way `createWorktree` resolves it (the
     * default branch when null; origin freshened first when credentials are given) — for
     * adapters that create no directory here (the capture store).
     */
    readonly resolveBase: (
      storePath: string,
      base: string | null,
      remoteEnv: GitRemoteEnvironment | null,
    ) => Effect.Effect<{ readonly baseRef: string; readonly baseSha: Sha }, GitError>;
    /**
     * Rename the branch a worktree is on in place (`git branch -m`) — the display-identity
     * half of a rename; the directory never moves (workspace bind mounts point there).
     */
    readonly renameBranch: (
      worktreePath: string,
      newBranch: string,
    ) => Effect.Effect<void, GitError>;
    /**
     * Freshen an existing worktree to `base` (default branch when null) without recreating it:
     * hard-reset the session branch, then clean untracked files. Ignore rules — including the
     * store-level excludes — keep dependency stores in place. For a bind-mounted worktree the
     * reset is immediately visible inside a running workspace.
     */
    readonly resetWorktree: (
      storePath: string,
      name: string,
      base: string | null,
      remoteEnv: GitRemoteEnvironment | null,
    ) => Effect.Effect<
      { readonly path: string; readonly baseSha: Sha; readonly baseRef: string },
      GitError
    >;
    /**
     * Fetch every origin branch into the store — remote-tracking names AND local heads, so
     * session bases and the default-branch tree both read current. Never prunes: session
     * branches live in `refs/heads` and a deleted upstream branch must not take them along.
     */
    readonly refreshFromOrigin: (
      storePath: string,
      remoteEnv: GitRemoteEnvironment,
    ) => Effect.Effect<void, GitError>;
    /** Branches a session can base on — origin's view merged with local-only heads. */
    readonly listBranches: (
      storePath: string,
    ) => Effect.Effect<ReadonlyArray<StoreBranch>, GitError>;
    /** Remove a session worktree; checkpoint refs survive in the bare repo. */
    readonly removeWorktree: (storePath: string, name: string) => Effect.Effect<void, GitError>;
    /**
     * Best-effort worktree removal for session deletion: git first, then a
     * plain rm for what git refuses (container-uid files from workspace
     * builds). Never fails — a surviving path is reported, not thrown.
     */
    readonly removeWorktreeForce: (
      storePath: string,
      name: string,
    ) => Effect.Effect<{ readonly leftover: string | null }>;
    /**
     * Remove the project's whole store directory (bare repo + worktrees).
     * Same honesty contract: a path that would not delete is the answer.
     */
    readonly removeProjectStore: (
      storePath: string,
    ) => Effect.Effect<{ readonly leftover: string | null }>;
    /**
     * Snapshot the worktree without touching HEAD, index, or files: throwaway
     * index → write-tree → commit-tree (parented on the previous checkpoint)
     * → update-ref `refs/mend/checkpoints/<scope>/<n>`. `scope` is the chain's
     * namespace — the worktree id (legacy refs used session ids; rows store
     * their refs, so both stay resolvable).
     */
    readonly checkpoint: (
      worktreePath: string,
      scope: string,
      index: number,
      parent: Sha | null,
    ) => Effect.Effect<CheckpointSnapshot, GitError>;
    /** Unified diff between two commits (a checkpoint slice: `refA..refB`). */
    readonly diffRange: (
      dir: string,
      a: string,
      b: string,
      options?: DiffRangeOptions,
    ) => Effect.Effect<string, GitError>;
    /** Unified diff of the live worktree against a base commit. */
    readonly diffWorktree: (worktreePath: string, base: string) => Effect.Effect<string, GitError>;
    /** Compare the full current worktree tree, including untracked files, to one commit tree. */
    readonly worktreeMatchesCommit: (
      worktreePath: string,
      commit: string,
    ) => Effect.Effect<boolean, GitError>;
    /** Per-file +/− counts for a range (`--numstat`); binary files count as 0/0. */
    readonly changedFiles: (
      dir: string,
      a: string,
      b: string | null,
    ) => Effect.Effect<ReadonlyArray<ChangedFile>, GitError>;
    /** Rename-aware file facts for an immutable commit range. */
    readonly diffFileFacts: (
      dir: string,
      a: string,
      b: string,
      options?: { readonly ignoreWhitespace?: boolean },
    ) => Effect.Effect<ReadonlyArray<DiffFileFact>, GitError>;
    /**
     * `diffFileFacts` within a budget: each of git's listings read up to `maxBytes` and
     * `deadlineMs`, a cut one answering its first whole records and `cut`, never a buffer failure.
     * `paths` lists only those files, without enumerating the range.
     */
    readonly diffFileFactsBounded: (
      dir: string,
      a: string,
      b: string,
      options: DiffFileFactsOptions,
    ) => Effect.Effect<DiffFileFactsListing, GitError>;
    readonly headSha: (dir: string) => Effect.Effect<Sha, GitError>;
    /**
     * Every path a session worktree holds right now — tracked plus untracked,
     * ignore rules applied (so dependency stores never appear). Sorted, capped
     * at `limit`; `truncated` says the cap bit.
     */
    readonly listWorktreeFiles: (
      worktreePath: string,
      limit: number,
    ) => Effect.Effect<FileListing, GitError>;
    /**
     * The start of one file of a commit's tree (`cat-file blob rev:path`), at most `maxBytes`;
     * null when the tree has no file there. Read-only.
     */
    readonly readBlob: (
      dir: string,
      rev: string,
      relative: string,
      maxBytes: number,
    ) => Effect.Effect<FileRead | null, GitError>;
    /** Current bytes from a contained regular file, without buffering the whole file. */
    readonly openRawWorktreeFile: (
      worktreePath: string,
      relative: string,
      within: string,
    ) => Effect.Effect<OpenRawFile, RawReadError, Scope.Scope>;
    /**
     * The start of one file of a worktree as it stands on disk, at most `maxBytes`; null when
     * nothing readable is there, or the path leaves the worktree (a symlink out of it, `.git`).
     */
    readonly readWorktreeFile: (
      worktreePath: string,
      relative: string,
      maxBytes: number,
    ) => Effect.Effect<FileRead | null, GitError>;
    /**
     * Lines matching `query` (`git grep`), in a commit's tree, or with `rev` null in a worktree
     * as it stands, untracked files included and ignored ones not; at most `limit`.
     */
    readonly grep: (
      dir: string,
      rev: string | null,
      query: GrepQuery,
      limit: number,
    ) => Effect.Effect<GrepResult, GitError>;
    /** Every path in one commit's tree (`ls-tree -r`), for the bare store when no worktree is in play. */
    readonly listTreeFiles: (
      dir: string,
      ref: string,
      limit: number,
    ) => Effect.Effect<FileListing, GitError>;
    /**
     * The entries at the root of one commit's tree (`ls-tree`, not recursive), a directory with
     * a trailing `/`: what a project holds at a glance, without walking a large repository.
     */
    readonly listTopLevel: (
      dir: string,
      ref: string,
      limit: number,
    ) => Effect.Effect<FileListing, GitError>;
    /**
     * Clone `source` shallow into `directory` (relative to the store root) as read-only source
     * material (plan §17, decided 2026-08-01). References belong to an organization, so callers
     * pass `referenceDirectory(organizationId, referenceId)`. `ref` pins a branch or tag; null
     * follows the remote's default branch. A working clone, not bare — the point is an agent
     * reading files.
     */
    readonly cloneReference: (
      directory: string,
      source: string,
      ref: string | null,
      remoteEnv: GitRemoteEnvironment,
    ) => Effect.Effect<ReferenceClone, ReferenceCloneError>;
    /** Re-fetch the pinned ref (or the clone's branch) shallow and hard-reset to it. */
    readonly refreshReference: (
      clonePath: string,
      ref: string | null,
      remoteEnv: GitRemoteEnvironment,
    ) => Effect.Effect<ReferenceClone, GitError>;
    /** Delete the clone directory. Selection rows are the caller's concern. */
    readonly removeReference: (clonePath: string) => Effect.Effect<void>;
    /**
     * Landing step 2 (docs/adr/0007-landing.md) in the project store: Mend's commit of the
     * checkpoint's tree, parented by `planLanding` on the last landing and the agent's head, or
     * nothing when an existing commit already is what lands. The session's branch never moves:
     * the landed head is kept under `refs/mend/landed/<worktree>` when `keepFor` names one.
     * `commit-tree` and `update-ref` in the bare store only, so the worktree's files, index and
     * HEAD file are never touched.
     */
    readonly landingCommit: (
      storePath: string,
      input: StoreLandingCommitInput,
    ) => Effect.Effect<LandingCommit, GitError>;
    /** Landing step 3: fast-forward-only push; a refusal is typed and in the remote's words. */
    readonly push: (
      storePath: string,
      input: PushInput,
    ) => Effect.Effect<Pushed, GitError | InvalidBranchError | PushRefusedError>;
    /** Origin's branch against a local commit: "origin has moved", "the landed commit is on origin". */
    readonly probeRemote: (
      storePath: string,
      input: ProbeInput,
    ) => Effect.Effect<RemoteBranchState, GitError | InvalidBranchError>;
    /** A git bundle of `base..tip` naming the branch, for `mend pull`; refused over the limit. */
    readonly bundle: (
      storePath: string,
      input: BundleInput,
    ) => Effect.Effect<
      ChangeBundle,
      GitError | InvalidBranchError | BundleTooLargeError | BundleEmptyError
    >;
    readonly freshenBase: (
      storePath: string,
      baseRef: string,
      remoteEnv: GitRemoteEnvironment | null,
    ) => Effect.Effect<FreshenOutcome>;
    readonly admitHandoff: (
      storePath: string,
      defaultBranch: string,
      bundle: Uint8Array,
      options: AdmitHandoffOptions,
    ) => Effect.Effect<
      AdmittedHandoff,
      HandoffRefusedError | HandoffFileOverBudgetError | GitError
    >;
    readonly sweepHandoffQuarantines: () => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@mend/store/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const config = yield* StoreConfig;

      /**
       * Dependency and artifact stores are never review content. This is
       * git-level policy — `$GIT_COMMON_DIR/info/exclude`, which every linked
       * worktree inherits — so diffs, status, and checkpoints all agree,
       * without touching the project's own .gitignore. Found live: a workspace
       * `pnpm install` dumped `.pnpm-store` (62k files) into the worktree of a
       * repo that doesn't ignore it, and the review diff drowned.
       */
      const MEND_EXCLUDES = ["node_modules/", ".pnpm-store/", ".npm/", "__pycache__/", ".venv/"];
      const ensureExcludes = (storePath: string) =>
        Effect.sync(() => {
          const file = path.join(storePath, "info", "exclude");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          const missing = MEND_EXCLUDES.filter((entry) => !current.includes(entry));
          if (missing.length > 0) {
            fs.appendFileSync(
              file,
              `\n# mend: dependency stores are not review content\n${missing.join("\n")}\n`,
            );
          }
        });

      /**
       * Root-uid defense (docs/BUGS.md 2026-08-30): workspace containers run git as ROOT
       * against this very gitdir (the worktree's real state lives here, so the pod mounts it),
       * and a root-side `git gc --auto` used to leave `packed-refs` and `refs/heads/mend/`
       * root-owned — after which this process (uid 1000) could not create a session ref and
       * every provision failed. `core.sharedRepository=group` makes every git — root's
       * included — create group-writable files and setgid directories, so whatever uid wrote
       * last, the group keeps write. The one-time walk repairs what THIS uid already owns;
       * files another uid left behind need the out-of-band chown (only root may re-group them).
       * Skipped entirely once the config records the policy — the walk must not tax every
       * worktree create.
       */
      const ensureSharedGroup = Effect.fn("Store.ensureSharedGroup")(function* (storePath: string) {
        const current = yield* git(["config", "--get", "core.sharedRepository"], storePath).pipe(
          Effect.catch(() => Effect.succeed("")),
        );
        if (current === "group") return;
        yield* git(["config", "core.sharedRepository", "group"], storePath);
        yield* Effect.sync(() => shareTree(storePath));
      });

      const adopt = Effect.fn("Store.adopt")(function* (
        directory: string,
        source: RepositoryCloneUrl,
        remoteEnv: GitRemoteEnvironment,
      ) {
        const projectDir = path.join(config.root, directory);
        const storePath = path.join(projectDir, "repo.git");
        const attempt = Effect.gen(function* () {
          yield* Effect.sync(() => fs.mkdirSync(config.root, { recursive: true }));
          const env = yield* gitRemoteEnvironment(remoteEnv, {
            direction: "clone",
            remote: source,
            env: {},
            cwd: config.root,
            destinationPath: storePath,
            cloneKind: "bare",
          });
          yield* git(["clone", "--bare", "--", source, storePath], config.root, env);
          // A SHA-256 repository is refused before anything is made of it, and the clone it just
          // made is removed (and the project directory, when that left it empty).
          yield* refuseUnsupportedRepository(storePath).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                fs.rmSync(storePath, { recursive: true, force: true });
                if (fs.existsSync(projectDir) && fs.readdirSync(projectDir).length === 0) {
                  fs.rmdirSync(projectDir);
                }
              }),
            ),
          );
          // Bare clones don't fetch new branches by default — make later syncs sane.
          yield* git(
            ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
            storePath,
          );
          yield* ensureExcludes(storePath);
          yield* ensureSharedGroup(storePath);
          const defaultBranch = yield* git(["symbolic-ref", "--short", "HEAD"], storePath);
          const head = yield* git(["rev-parse", "HEAD"], storePath);
          return { storePath, defaultBranch, headSha: sha(head) };
        });
        return yield* attempt.pipe(
          Effect.catch((cause) => Effect.fail(new AdoptError({ directory, source, cause }))),
        );
      }, Effect.scoped);

      /**
       * Freshen one base ref from the project origin before resolving it — best-effort by
       * contract: a session must start offline, on a disconnected bridge, or against a gone
       * remote, just on the base the store already has. `remoteEnv` null means the caller could
       * not resolve credentials (and said why); no fetch is attempted at all.
       */
      const freshenBase = Effect.fn("Store.freshenBase")(function* (
        storePath: string,
        baseRef: string,
        remoteEnv: GitRemoteEnvironment | null,
      ) {
        if (remoteEnv === null) {
          return skippedFreshen("this server has no credential of yours for origin");
        }
        const fetched = yield* refuseRemoteCredentials(storePath).pipe(
          Effect.andThen(
            gitRemoteEnvironment(remoteEnv, {
              direction: "read",
              remote: "origin",
              repositoryPath: storePath,
              env: {},
            }),
          ),
          Effect.flatMap((env) => git(["fetch", "origin", baseRef], storePath, env)),
          Effect.result,
        );
        if (Result.isSuccess(fetched)) return fetchedFreshen;
        yield* Effect.logDebug("store: base freshen skipped").pipe(
          Effect.annotateLogs({ storePath, baseRef, stderr: fetched.failure.stderr }),
        );
        return failedFreshen(fetched.failure.stderr);
      }, Effect.scoped);

      /**
       * Resolve a requested base to a commit, preferring what origin says over the store's own
       * head: local `refs/heads/*` freeze at adoption, while `refs/remotes/origin/*` move with
       * every fetch — so the remote-tracking name is the current answer and the local name is
       * the fallback (shas, tags, and never-pushed local branches). A base the store does not
       * know at all gets one authenticated fetch (a branch pushed but never fetched — adopt
       * configures the refspec for exactly this). If git then proves both names missing, a
       * successful fetch reports the unknown base; a failed fetch or refusal keeps its original
       * reason, and a resolution that failed any other way keeps its own.
       */
      const resolveBaseSha = Effect.fn("Store.resolveBaseSha")(function* (
        storePath: string,
        baseRef: string,
        remoteEnv: GitRemoteEnvironment | null,
      ) {
        return yield* knownBaseSha(storePath, baseRef).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              const fetched = yield* refuseRemoteCredentials(storePath).pipe(
                Effect.andThen(
                  // Without a signer, ssh refuses rather than answer as the server process.
                  gitRemoteEnvironment(remoteEnv ?? noSignerGitEnv(), {
                    direction: "read",
                    remote: "origin",
                    repositoryPath: storePath,
                    env: {},
                  }).pipe(Effect.flatMap((env) => git(["fetch", "origin"], storePath, env))),
                ),
                Effect.result,
              );
              // A ref that became available locally still wins after a failed best-effort fetch.
              const commit = yield* gitCommitOf(baseRef, storePath).pipe(
                Effect.flatMap((found) =>
                  found === null
                    ? gitCommitOf(`origin/${baseRef}`, storePath)
                    : Effect.succeed(found),
                ),
                Effect.mapError((cause) => (Result.isFailure(fetched) ? fetched.failure : cause)),
              );
              if (commit !== null) return commit;
              return yield* Effect.fail(
                Result.isFailure(fetched)
                  ? fetched.failure
                  : new GitError({
                      args: ["rev-parse", `${baseRef}^{commit}`],
                      cwd: storePath,
                      exitCode: 1,
                      stderr: `base "${baseRef}" is not a branch, tag, or commit this project's store knows (origin was fetched and it is still unknown) — push it to the project origin or start from another base`,
                      unknownBase: baseRef,
                    }),
              );
            }),
          ),
        );
      }, Effect.scoped);

      const createWorktree = Effect.fn("Store.createWorktree")(function* (
        storePath: string,
        identity: { readonly directory: string; readonly branch: string },
        base: string | null,
        remoteEnv: GitRemoteEnvironment | null,
      ) {
        // The worktree's admin dir, and on the co-located store the whole store, reach a workspace.
        yield* refuseRemoteCredentials(storePath);
        // Idempotent: stores adopted before the exclude or shared-group policies get them here.
        yield* ensureExcludes(storePath);
        yield* ensureSharedGroup(storePath);
        const baseRef = base ?? (yield* git(["symbolic-ref", "--short", "HEAD"], storePath));
        yield* freshenBase(storePath, baseRef, remoteEnv);
        const baseSha = yield* resolveBaseSha(storePath, baseRef, remoteEnv);
        const { directory, branch } = identity;
        // Backstop behind the worktrees table's uniqueness: a branch that already
        // exists means the name is in use (possibly by a pre-pivot session row).
        const taken = yield* git(
          ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          storePath,
        ).pipe(Effect.result);
        if (taken._tag === "Success") {
          return yield* new GitError({
            args: ["worktree", "add"],
            cwd: storePath,
            exitCode: null,
            stderr: `branch "${branch}" already exists in this project — pick another worktree name`,
          });
        }
        const worktreePath = path.join(path.dirname(storePath), "worktrees", directory);
        yield* git(["worktree", "add", "-b", branch, worktreePath, baseSha], storePath);
        // `git worktree add` does not shared-perm its admin dir the way ref writes are; the
        // checkpoint index and HEAD for this worktree live there, so share it explicitly.
        yield* Effect.sync(() => shareTree(path.join(storePath, "worktrees", directory)));
        return { path: worktreePath, name: directory, branch, baseSha: sha(baseSha), baseRef };
      });

      const resolveBase = Effect.fn("Store.resolveBase")(function* (
        storePath: string,
        base: string | null,
        remoteEnv: GitRemoteEnvironment | null,
      ) {
        const baseRef = base ?? (yield* git(["symbolic-ref", "--short", "HEAD"], storePath));
        yield* freshenBase(storePath, baseRef, remoteEnv);
        const baseSha = yield* resolveBaseSha(storePath, baseRef, remoteEnv);
        return { baseRef, baseSha: sha(baseSha) };
      });

      const quarantineRoot = path.join(config.root, "tmp");

      const admitHandoff: Store["Service"]["admitHandoff"] = (
        storePath,
        defaultBranch,
        bundle,
        options,
      ) =>
        admitHandoffIn({
          storePath,
          defaultBranch,
          bundle,
          quarantineRoot,
          fileBytes: options.fileBytes,
          defaultTip: knownBaseSha(storePath, defaultBranch).pipe(
            Effect.map((tip): string | null => tip),
            Effect.catch(() => Effect.succeed<string | null>(null)),
          ),
          freshenDefault: options.freshen,
        });

      const sweepHandoffQuarantines: Store["Service"]["sweepHandoffQuarantines"] = () =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => sweepQuarantinesUnder(quarantineRoot, now)),
        );

      const renameBranch = Effect.fn("Store.renameBranch")(function* (
        worktreePath: string,
        newBranch: string,
      ) {
        yield* git(["branch", "-m", newBranch], worktreePath);
      });

      const resetWorktree = Effect.fn("Store.resetWorktree")(function* (
        storePath: string,
        name: string,
        base: string | null,
        remoteEnv: GitRemoteEnvironment | null,
      ) {
        const worktreePath = path.join(path.dirname(storePath), "worktrees", name);
        yield* refuseRemoteCredentials(storePath);
        const baseRef = base ?? (yield* git(["symbolic-ref", "--short", "HEAD"], storePath));
        yield* freshenBase(storePath, baseRef, remoteEnv);
        const baseSha = yield* resolveBaseSha(storePath, baseRef, remoteEnv);
        yield* git(["reset", "--hard", baseSha], worktreePath);
        yield* git(["clean", "-fd"], worktreePath);
        return { path: worktreePath, baseSha: sha(baseSha), baseRef };
      });

      const refreshFromOrigin = Effect.fn("Store.refreshFromOrigin")(function* (
        storePath: string,
        remoteEnv: GitRemoteEnvironment,
      ) {
        // Both refspecs in one fetch: heads for the store's own tree reads (files listing,
        // default-branch resolution), remote-tracking for base resolution. Forced — the store
        // holds no local work on origin's branches. Sessions commit on `mend/*` only, and
        // landings push `mend/*` to origin (docs/adr/0007-landing.md), so the negative refspec
        // keeps origin's `mend/*` from overwriting, or refusing to fetch into, a session branch a
        // worktree has checked out.
        yield* refuseRemoteCredentials(storePath);
        const env = yield* gitRemoteEnvironment(remoteEnv, {
          direction: "read",
          remote: "origin",
          repositoryPath: storePath,
          env: {},
        });
        yield* git(
          [
            "fetch",
            "origin",
            "+refs/heads/*:refs/heads/*",
            "+refs/heads/*:refs/remotes/origin/*",
            `^${SESSION_BRANCHES}`,
          ],
          storePath,
          env,
        );
      }, Effect.scoped);

      /** `for-each-ref` line → parts; the formats below join with a tab (refnames cannot hold one). */
      const branchLine = (line: string): { name: string; sha: Sha; committedAt: string } | null => {
        const [name, refSha, committedAt] = line.split("\t");
        if (name === undefined || name === "" || refSha === undefined || committedAt === undefined)
          return null;
        return { name, sha: sha(refSha), committedAt };
      };

      const listBranches = Effect.fn("Store.listBranches")(function* (storePath: string) {
        const fields = "%09%(objectname)%09%(committerdate:iso-strict)";
        const defaultBranch = yield* git(["symbolic-ref", "--short", "HEAD"], storePath);
        // Origin's view wins where both exist: local heads freeze at adoption, remote-tracking
        // refs move with every fetch. Local-only heads still list (bases can be local).
        const remote = yield* git(
          ["for-each-ref", `--format=%(refname:lstrip=3)${fields}`, "refs/remotes/origin"],
          storePath,
        );
        const local = yield* git(
          ["for-each-ref", `--format=%(refname:lstrip=2)${fields}`, "refs/heads"],
          storePath,
        );
        const byName = new Map<string, { name: string; sha: Sha; committedAt: string }>();
        // Session branches (`mend/<name>`, `mend/wt/<id>`, `mend/session/<id>`) and the branches
        // landings push to origin under the same names are never a base.
        for (const line of local.split("\n")) {
          const parsed = branchLine(line);
          if (parsed === null || isSessionBranch(parsed.name)) continue;
          byName.set(parsed.name, parsed);
        }
        for (const line of remote.split("\n")) {
          const parsed = branchLine(line);
          if (parsed === null || parsed.name === "HEAD" || isSessionBranch(parsed.name)) continue;
          byName.set(parsed.name, parsed);
        }
        return [...byName.values()]
          .toSorted((a, b) => b.committedAt.localeCompare(a.committedAt))
          .map((entry) => ({ ...entry, isDefault: entry.name === defaultBranch }));
      });

      const removeWorktree = Effect.fn("Store.removeWorktree")(function* (
        storePath: string,
        name: string,
      ) {
        const worktreePath = path.join(path.dirname(storePath), "worktrees", name);
        yield* git(["worktree", "remove", "--force", worktreePath], storePath);
      });

      const removeWorktreeForce = Effect.fn("Store.removeWorktreeForce")(function* (
        storePath: string,
        name: string,
      ) {
        const worktreePath = path.join(path.dirname(storePath), "worktrees", name);
        yield* git(["worktree", "remove", "--force", worktreePath], storePath).pipe(Effect.ignore);
        const result = yield* Effect.sync(() => rmBestEffort(worktreePath));
        // Drop the stale registration when the directory did go away.
        yield* git(["worktree", "prune"], storePath).pipe(Effect.ignore);
        return result;
      });

      const removeProjectStore = Effect.fn("Store.removeProjectStore")(function* (
        storePath: string,
      ) {
        return yield* Effect.sync(() => rmBestEffort(path.dirname(storePath)));
      });

      const checkpoint = Effect.fn("Store.checkpoint")(function* (
        worktreePath: string,
        scope: string,
        index: number,
        parent: Sha | null,
      ) {
        const tmpIndex = path.join(os.tmpdir(), `mend-checkpoint-${scope}-${index}-${process.pid}`);
        const env = { GIT_INDEX_FILE: tmpIndex };
        const snapshot = Effect.gen(function* () {
          yield* git(["add", "-A"], worktreePath, env);
          const tree = yield* git(["write-tree"], worktreePath, env);
          const message = `mend checkpoint ${index}`;
          const commitArgs =
            parent === null
              ? ["commit-tree", tree, "-m", message]
              : ["commit-tree", tree, "-p", parent, "-m", message];
          const commit = yield* git(commitArgs, worktreePath);
          const ref = `refs/mend/checkpoints/${scope}/${index}`;
          yield* git(["update-ref", ref, commit], worktreePath);
          return { ref, sha: sha(commit) };
        });
        return yield* snapshot.pipe(
          Effect.ensuring(Effect.sync(() => fs.rmSync(tmpIndex, { force: true }))),
        );
      });

      const diffRange = Effect.fn("Store.diffRange")(function* (
        dir: string,
        a: string,
        b: string,
        options?: DiffRangeOptions,
      ) {
        const args = options?.paths === undefined ? [] : ["--literal-pathspecs"];
        args.push("diff", "--find-renames");
        if (options?.ignoreWhitespace === true) args.push("--ignore-all-space");
        if (options?.contextLines !== undefined) args.push(`--unified=${options.contextLines}`);
        args.push(a, b);
        if (options?.paths !== undefined) args.push("--", ...options.paths);
        if (options?.maxBytes === undefined) return yield* git(args, dir);
        const out = yield* gitCapped(args, dir, options.maxBytes);
        if (!out.cut) return out.stdout;
        // Cut: only the files rendered whole stay; a half file is no patch.
        const last = out.stdout.lastIndexOf("\ndiff --git ");
        return last <= 0 ? "" : out.stdout.slice(0, last);
      });

      const worktreeMatchesCommit = Effect.fn("Store.worktreeMatchesCommit")(function* (
        worktreePath: string,
        commit: string,
      ) {
        const tmpIndex = path.join(
          os.tmpdir(),
          `mend-tree-compare-${process.pid}-${crypto.randomUUID()}`,
        );
        const currentTree = yield* Effect.gen(function* () {
          const env = { GIT_INDEX_FILE: tmpIndex };
          yield* git(["add", "-A"], worktreePath, env);
          return yield* git(["write-tree"], worktreePath, env);
        }).pipe(Effect.ensuring(Effect.sync(() => fs.rmSync(tmpIndex, { force: true }))));
        const expectedTree = yield* git(["rev-parse", `${commit}^{tree}`], worktreePath);
        return currentTree === expectedTree;
      });

      /**
       * Rendering an untracked file costs one `git diff --no-index` spawn, so
       * an unreviewable explosion (a dependency store dumped into the worktree
       * escaped every ignore rule once: 62k files, one spawn each — the review
       * page "hung") is capped hard. The excluded tail is a count the caller
       * can surface; it is never silently dropped git-side.
       */
      const UNTRACKED_RENDER_LIMIT = 200;

      const diffWorktree = Effect.fn("Store.diffWorktree")(function* (
        worktreePath: string,
        base: string,
      ) {
        const tracked = yield* git(["diff", base], worktreePath);
        const untracked = yield* untrackedIn(worktreePath);
        const rendered = untracked.slice(0, UNTRACKED_RENDER_LIMIT);
        if (untracked.length > rendered.length) {
          yield* Effect.logWarning("store: untracked files over render limit").pipe(
            Effect.annotateLogs({ worktreePath, untracked: untracked.length }),
          );
        }
        const additions = yield* Effect.forEach(rendered, (file) =>
          // Exit 1 means "the files differ" — for /dev/null vs a new file, that IS the diff.
          git(["diff", "--no-index", "--", "/dev/null", file], worktreePath, undefined, [1]),
        );
        return [tracked, ...additions].filter((part) => part !== "").join("\n");
      });

      const changedFiles = Effect.fn("Store.changedFiles")(function* (
        dir: string,
        a: string,
        b: string | null,
      ) {
        const args =
          b === null ? ["diff", "--numstat", "-z", a] : ["diff", "--numstat", "-z", a, b];
        const out = yield* git(args, dir);
        const tracked = parseNumstat(out).map(({ path: file, additions, deletions }) => ({
          path: file,
          additions,
          deletions,
        }));
        // A live-worktree comparison (b = null) also owns its untracked files.
        if (b !== null) return tracked;
        const untracked = yield* untrackedIn(dir);
        const rendered = untracked.slice(0, UNTRACKED_RENDER_LIMIT);
        const elided = untracked.length - rendered.length;
        const additions = yield* Effect.forEach(rendered, (file) =>
          git(
            ["diff", "--no-index", "--numstat", "--", "/dev/null", file],
            dir,
            undefined,
            [1],
          ).pipe(
            Effect.map((line) => {
              const [added = "0"] = line.split("\t");
              return {
                path: file,
                additions: added === "-" ? 0 : Number(added),
                deletions: 0,
              };
            }),
          ),
        );
        // The elided tail still COUNTS — an honest row instead of silence.
        return elided > 0
          ? [
              ...tracked,
              ...additions,
              {
                path: `… ${elided} more untracked files (not rendered)`,
                additions: 0,
                deletions: 0,
              },
            ]
          : [...tracked, ...additions];
      });

      const diffFileFacts = Effect.fn("Store.diffFileFacts")(function* (
        dir: string,
        a: string,
        b: string,
        options?: { readonly ignoreWhitespace?: boolean },
      ) {
        const whitespace = options?.ignoreWhitespace === true ? ["--ignore-all-space"] : [];
        const [names, counts] = yield* Effect.all([
          git(["diff", "--name-status", "-z", "--find-renames", ...whitespace, a, b], dir),
          git(["diff", "--numstat", "-z", "--find-renames", ...whitespace, a, b], dir),
        ]);
        return parseNameStatus(names, parseNumstat(counts));
      });

      const diffFileFactsBounded = Effect.fn("Store.diffFileFactsBounded")(function* (
        dir: string,
        a: string,
        b: string,
        options: DiffFileFactsOptions,
      ) {
        // One budget for the operation: every git run takes what is left of it.
        const started = yield* Clock.currentTimeMillis;
        const left = (until: number | undefined) =>
          until === undefined
            ? Effect.succeed(undefined)
            : Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, until - (now - started)));
        const run =
          (until: number | undefined): CappedRun =>
          (args) =>
            Effect.flatMap(left(until), (budget) =>
              budget === 0
                ? Effect.succeed({ stdout: Buffer.alloc(0), cut: true })
                : gitCappedBytes(args, dir, options.maxBytes, budget),
            );
        const listing = (format: string, pathspecs: ReadonlyArray<string> | undefined) =>
          Effect.flatMap(left(options.deadlineMs), (budget) => {
            if (budget === 0) return Effect.succeed({ stdout: Buffer.alloc(0), cut: true });
            // The caller's paths are literal by flag; a floor's carry their own magic.
            const args =
              options.paths === undefined
                ? pathspecs === undefined
                  ? []
                  : ["--no-literal-pathspecs"]
                : ["--literal-pathspecs"];
            args.push("diff", format, "-z", "--find-renames");
            if (options.ignoreWhitespace === true) args.push("--ignore-all-space");
            args.push(a, b);
            if (options.paths !== undefined) args.push("--", ...options.paths);
            else if (pathspecs !== undefined) args.push("--", ...pathspecs);
            return gitCappedBytes(args, dir, options.maxBytes, budget);
          });
        const list = Effect.fn(function* (
          pathspecs: ReadonlyArray<string> | undefined,
          keep?: (listed: Buffer | null) => boolean,
        ) {
          const [names, counts] = yield* Effect.all(
            [listing("--name-status", pathspecs), listing("--numstat", pathspecs)],
            { concurrency: 2 },
          );
          // Both listings are git's, record for record: a record kept or dropped in one is in
          // the other, by its index, before either is read as text.
          const kept =
            keep === undefined
              ? undefined
              : rawNameStatusPaths(names.stdout).map(
                  (record) => keep(record.newPath) || keep(record.oldPath),
                );
          const records = nameStatusRecords(names.stdout.toString("utf8")).filter(
            (_, index) => kept === undefined || kept[index] === true,
          );
          const numbers = numstatRecords(counts.stdout.toString("utf8")).filter(
            (_, index) => kept === undefined || kept[index] === true,
          );
          // Both listings are git's, in the same order: joined record by record while they agree.
          const facts: Array<DiffFileFact> = [];
          for (const [index, record] of records.entries()) {
            const count = numbers[index];
            if (count === undefined || count.path !== (record.newPath ?? record.oldPath)) break;
            facts.push({
              oldPath: record.oldPath,
              newPath: record.newPath,
              status: record.status,
              additions: count.additions,
              deletions: count.deletions,
              binary: count.binary,
            });
          }
          return {
            facts,
            cut: names.cut || counts.cut || facts.length < records.length,
          } satisfies DiffFileFactsListing;
        });
        const minFiles = options.minFiles;
        if (
          options.paths !== undefined ||
          minFiles === undefined ||
          options.deadlineMs === undefined
        ) {
          return yield* list(undefined);
        }
        // Git prints a range's files only after walking the whole range, so a deadline mid-walk
        // lists nothing. The first files are found directory by directory and listed by path,
        // beside the whole listing, from half the deadline on (the whole listing usually answers
        // first) until it ends: the walk until half of what is then left, the listing by path
        // until the deadline, so the files the walk found are listed within it.
        const deadlineMs = options.deadlineMs;
        const floor = Effect.gen(function* () {
          yield* Effect.sleep(deadlineMs / 2);
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          const walkUntil = elapsed + (deadlineMs - elapsed) / 2;
          let found: DiffFileFactsListing = { facts: [], cut: true };
          for (let limit = minFiles; ; limit *= 2) {
            const selection = yield* firstChangedPaths(a, b, limit, run(walkUntil));
            // One command line for both listings, within every platform's limit: a selection
            // past it is shortened, never split, since each listing pairs renames on its own.
            const items: Array<SelectedPath> = [];
            const pathspecs: Array<string> = [];
            let bytes = 0;
            for (const item of selection.items) {
              const specs = pathspecsOf(item);
              bytes += specs.reduce((sum, spec) => sum + Buffer.byteLength(spec) + 1, 0);
              if (bytes > SELECTION_BYTES) break;
              items.push(item);
              pathspecs.push(...specs);
            }
            if (items.length === 0) return found;
            // A host whose argument limit is below the bound refuses the command line (E2BIG):
            // half the selection is listed instead, as many halvings as it takes, the same
            // selection for both listings. One pathspec refused answers nothing, cut.
            let listed: DiffFileFactsListing | undefined;
            while (listed === undefined) {
              const attempt = yield* list(pathspecs, selectedBy(items)).pipe(
                Effect.catchIf(
                  (error) => error.code === "E2BIG",
                  () => Effect.succeed(undefined),
                ),
              );
              if (attempt !== undefined) listed = attempt;
              else if (items.length <= 1) listed = { facts: [], cut: true };
              else {
                items.splice(Math.ceil(items.length / 2));
                pathspecs.splice(0, pathspecs.length, ...items.flatMap(pathspecsOf));
              }
            }
            const shortened = items.length < selection.items.length;
            const facts = listed.facts;
            const complete = selection.complete && !shortened && !listed.cut;
            if (facts.length >= found.facts.length) found = { facts, cut: !complete };
            // Renames pair two paths into one fact: more paths until the facts reach the floor.
            if (complete || shortened || facts.length >= minFiles || selection.cut) {
              return found;
            }
            if ((yield* left(deadlineMs)) === 0) return found;
          }
        }).pipe(Effect.forkChild);
        const floorFiber = yield* floor;
        const whole = yield* list(undefined);
        if (!whole.cut || whole.facts.length >= minFiles) {
          yield* Fiber.interrupt(floorFiber);
          return whole;
        }
        const found = yield* Fiber.join(floorFiber);
        return found.facts.length > whole.facts.length || !found.cut ? found : whole;
      });

      const listWorktreeFiles = Effect.fn("Store.listWorktreeFiles")(function* (
        worktreePath: string,
        limit: number,
      ) {
        // --cached --others in one call: tracked and untracked, ignore rules
        // applied (the store-level excludes keep dependency stores out). -z so
        // unusual names survive; git prints paths relative to the cwd.
        const out = yield* git(
          ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          worktreePath,
        );
        return capListing([...new Set(out.split("\0"))], limit);
      });

      const readBlob = Effect.fn("Store.readBlob")(function* (
        dir: string,
        rev: string,
        relative: string,
        maxBytes: number,
      ) {
        if (!isWorktreeRelativePath(relative)) return null;
        const spec = `${rev}:${relative}`;
        // 128: git found nothing at that path.
        const type = yield* git(["cat-file", "-t", spec], dir, undefined, [128]);
        if (type !== "blob") return null;
        const size = Number.parseInt(yield* git(["cat-file", "-s", spec], dir), 10);
        const bytes = new Uint8Array(yield* gitHead(["cat-file", "blob", spec], dir, maxBytes));
        return {
          bytes,
          size,
          truncated: size > bytes.byteLength,
          binary: binaryOf(bytes),
        } satisfies FileRead;
      });

      const readWorktreeFile = Effect.fn("Store.readWorktreeFile")(function* (
        worktreePath: string,
        relative: string,
        maxBytes: number,
      ) {
        if (!isWorktreeRelativePath(relative)) return null;
        return yield* Effect.try({
          try: (): FileRead | null => {
            const root = fs.realpathSync(worktreePath);
            const file = openContained(root, relative);
            if (file === null) return null;
            const handle = file.fd;
            try {
              // The descriptor, not the path: what was opened is what is checked and read.
              const stat = fs.fstatSync(handle);
              if (!stat.isFile() || !descriptorInside(file, root)) return null;
              const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
              const read = fs.readSync(handle, buffer, 0, buffer.byteLength, 0);
              const bytes = new Uint8Array(buffer.subarray(0, read));
              return {
                bytes,
                size: stat.size,
                truncated: stat.size > read,
                binary: binaryOf(bytes),
              };
            } finally {
              fs.closeSync(handle);
            }
          },
          catch: (error) =>
            new GitError({
              args: ["read-worktree-file", relative],
              cwd: worktreePath,
              exitCode: null,
              stderr: error instanceof Error ? error.message : String(error),
            }),
        });
      });

      const grep = Effect.fn("Store.grep")(function* (
        dir: string,
        rev: string | null,
        query: GrepQuery,
        limit: number,
      ) {
        const args = ["grep", "-n", "-z", "-I", "--no-color", `--max-count=${limit + 1}`];
        if (!query.caseSensitive) args.push("-i");
        if (query.wholeWord) args.push("-w");
        args.push(query.regex ? "-E" : "-F", "-e", query.pattern);
        args.push(...(rev === null ? ["--untracked"] : [rev]));
        // Bounded as a whole, not per file: git stops at the byte budget or the deadline, and what
        // it found by then answers, marked truncated. 1: nothing matched.
        const out = yield* gitCapped(args, dir, GREP_OUTPUT_BYTES, GREP_DEADLINE_MS).pipe(
          Effect.catchIf(
            (error) => error.exitCode === 1,
            () => Effect.succeed({ stdout: "", cut: false }),
          ),
        );
        return parseGrep(out.stdout, rev, limit, out.cut);
      });

      const listTreeFiles = Effect.fn("Store.listTreeFiles")(function* (
        dir: string,
        ref: string,
        limit: number,
      ) {
        const out = yield* git(["ls-tree", "-r", "-z", "--name-only", ref], dir);
        return capListing(out.split("\0"), limit);
      });

      const listTopLevel = Effect.fn("Store.listTopLevel")(function* (
        dir: string,
        ref: string,
        limit: number,
      ) {
        // `<mode> <type> <sha>\t<name>`, NUL-separated so unusual names survive.
        const out = yield* git(["ls-tree", "-z", ref], dir);
        const entries = out.split("\0").flatMap((line) => {
          const tab = line.indexOf("\t");
          if (tab === -1) return [];
          const name = line.slice(tab + 1);
          return [line.split(" ")[1] === "tree" ? `${name}/` : name];
        });
        return capListing(entries, limit);
      });

      const headSha = Effect.fn("Store.headSha")(function* (dir: string) {
        const head = yield* git(["rev-parse", "HEAD"], dir);
        return sha(head);
      });

      // `_organizations/` cannot collide with a project dir: project stores are ids or names
      // that went through the API's name check, which rejects a leading underscore.
      const cloneReference = Effect.fn("Store.cloneReference")(function* (
        directory: string,
        source: string,
        ref: string | null,
        remoteEnv: GitRemoteEnvironment,
      ) {
        const clonePath = path.join(config.root, directory);
        const referencesRoot = path.dirname(clonePath);
        const name = path.basename(clonePath);
        const attempt = Effect.gen(function* () {
          yield* Effect.sync(() => fs.mkdirSync(referencesRoot, { recursive: true }));
          const env = yield* gitRemoteEnvironment(remoteEnv, {
            direction: "clone",
            remote: source,
            env: {},
            cwd: referencesRoot,
            destinationPath: clonePath,
            cloneKind: "checkout",
          });
          yield* git(
            [
              "clone",
              "--depth",
              "1",
              ...(ref === null ? [] : ["--branch", ref]),
              "--",
              source,
              clonePath,
            ],
            referencesRoot,
            env,
          );
          const head = yield* git(["rev-parse", "HEAD"], clonePath);
          return { path: clonePath, headSha: sha(head) };
        });
        return yield* attempt.pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new ReferenceCloneError({ name, source: redactRepositoryUrl(source), cause }),
            ),
          ),
        );
      }, Effect.scoped);

      const refreshReference = Effect.fn("Store.refreshReference")(function* (
        clonePath: string,
        ref: string | null,
        remoteEnv: GitRemoteEnvironment,
      ) {
        // No pin = follow whatever branch the clone is on. FETCH_HEAD + hard
        // reset handles branches and tags uniformly, force-pushes included —
        // a reference clone has no local work to protect.
        // A reference clone is mounted into co-located workspaces, its config included.
        yield* refuseRemoteCredentials(clonePath);
        const target = ref ?? (yield* git(["symbolic-ref", "--short", "HEAD"], clonePath));
        const env = yield* gitRemoteEnvironment(remoteEnv, {
          direction: "read",
          remote: "origin",
          repositoryPath: clonePath,
          env: {},
        });
        yield* git(["fetch", "--depth", "1", "origin", target], clonePath, env);
        yield* git(["reset", "--hard", "FETCH_HEAD"], clonePath);
        const head = yield* git(["rev-parse", "HEAD"], clonePath);
        return { path: clonePath, headSha: sha(head) };
      }, Effect.scoped);

      const removeReference = Effect.fn("Store.removeReference")(function* (clonePath: string) {
        yield* Effect.sync(() => fs.rmSync(clonePath, { recursive: true, force: true }));
      });

      const landingCommit = Effect.fn("Store.landingCommit")(function* (
        storePath: string,
        input: StoreLandingCommitInput,
      ) {
        const landed = yield* writeLandingCommit(storePath, input);
        if (input.keepFor !== null) {
          // Mend's own namespace, never `refs/heads`: the agent's branch stays where it was.
          yield* git(
            ["update-ref", "-m", "mend: landing", landedRefOf(input.keepFor), landed.head],
            storePath,
          );
        }
        return landed;
      });

      const push = Effect.fn("Store.push")(function* (storePath: string, input: PushInput) {
        yield* refuseRemoteCredentials(storePath);
        return yield* pushBranch(storePath, input);
      });

      const probeRemote = Effect.fn("Store.probeRemote")(function* (
        storePath: string,
        input: ProbeInput,
      ) {
        yield* refuseRemoteCredentials(storePath);
        return yield* probeRemoteBranch(storePath, input);
      });

      const bundle = Effect.fn("Store.bundle")(function* (storePath: string, input: BundleInput) {
        return yield* createChangeBundle(storePath, input);
      });

      return {
        landingCommit,
        push,
        probeRemote,
        bundle,
        cloneReference,
        refreshReference,
        removeReference,
        adopt,
        createWorktree,
        resolveBase,
        freshenBase,
        admitHandoff,
        sweepHandoffQuarantines,
        renameBranch,
        resetWorktree,
        refreshFromOrigin,
        listBranches,
        removeWorktree,
        removeWorktreeForce,
        removeProjectStore,
        checkpoint,
        diffRange,
        diffWorktree,
        worktreeMatchesCommit,
        changedFiles,
        diffFileFacts,
        diffFileFactsBounded,
        headSha,
        listWorktreeFiles,
        readBlob,
        readWorktreeFile,
        openRawWorktreeFile,
        grep,
        listTreeFiles,
        listTopLevel,
      };
    }),
  );
}
