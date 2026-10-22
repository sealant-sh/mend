import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  formatHandoffMessage,
  HANDOFF_SNAPSHOT_REF,
  HandoffTrailers,
  isEnvPath,
} from "@mend/domain/workbench";
import { Schema } from "effect";

export type LeftOut =
  | { readonly path: string; readonly reason: "env" }
  | { readonly path: string; readonly reason: "over-limit"; readonly bytes: number }
  | { readonly path: string; readonly reason: "filter"; readonly filter: string };

export interface CommittedEnv {
  readonly path: string;
  readonly commit: string;
}

export type HiddenBit = "assume-unchanged" | "skip-worktree" | "assume-unchanged and skip-worktree";

/** A file whose edit git status does not show, which travels all the same. */
export interface Hidden {
  readonly path: string;
  readonly bit: HiddenBit;
}

export interface HandoffFacts {
  readonly commitsAhead: number;
  readonly uncommitted: number;
  readonly untracked: number;
}

export interface HandoffSnapshot {
  readonly head: string;
  readonly index: string;
  readonly worktree: string;
  readonly mergeBase: string;
  readonly defaultTip: string;
  readonly localBranch: string | null;
  readonly facts: HandoffFacts;
  readonly leftOut: ReadonlyArray<LeftOut>;
  readonly committedEnv: ReadonlyArray<CommittedEnv>;
  readonly hidden: ReadonlyArray<Hidden>;
  readonly bundlePath: string;
  readonly bundleBytes: number;
  readonly cutAt: string;
}

export type SnapshotOutcome =
  | { readonly _tag: "snapshot"; readonly snapshot: HandoffSnapshot }
  | { readonly _tag: "refused"; readonly message: string };

export interface SnapshotRequest {
  readonly checkout: string;
  readonly defaultBranch: string;
  readonly machine: string;
  readonly maxFileBytes: number;
  readonly scratch: string;
  readonly cutAt: Date;
  readonly env?: NodeJS.ProcessEnv;
}

const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.splitIndex=false",
  "core.untrackedCache=false",
  "gc.auto=0",
  "core.hooksPath=/dev/null",
  "log.showSignature=false",
];

class GitFailure extends Error {
  readonly words: string;
  constructor(command: string, words: string) {
    super(`git ${command} failed · ${words}`);
    this.words = words;
  }
}

type Env = Readonly<Record<string, string>>;

interface Git {
  readonly run: (env: Env, args: ReadonlyArray<string>, input?: Buffer | string) => Buffer;
  readonly attempt: (env: Env, args: ReadonlyArray<string>) => string | null;
}

const gitIn = (cwd: string, config: ReadonlyArray<string>): Git => {
  const spawn = (env: Env, args: ReadonlyArray<string>, input?: Buffer | string) =>
    spawnSync("git", [...config.flatMap((pair) => ["-c", pair]), ...args], {
      cwd,
      env,
      maxBuffer: 1 << 30,
      ...(input === undefined ? {} : { input }),
    });
  return {
    run: (env, args, input) => {
      const result = spawn(env, args, input);
      if (result.status !== 0) {
        const words = (result.stderr?.toString() ?? result.error?.message ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("hint:"))
          .join(" · ");
        throw new GitFailure(args[0] ?? "", words || `exit ${result.status}`);
      }
      return result.stdout;
    },
    attempt: (env, args) => {
      const result = spawn(env, args);
      return result.status === 0 ? result.stdout.toString() : null;
    },
  };
};

const scrubbed = (inherited: NodeJS.ProcessEnv): Env => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
  };
};

const GitPath = Schema.String.pipe(Schema.brand("GitPath"));
type GitPath = typeof GitPath.Type;

const NUL = Buffer.from([0]);
const TAB = 0x09;
const pathOf = (bytes: Buffer): GitPath => GitPath.make(bytes.toString("latin1"));
const bytesOf = (file: GitPath): Buffer => Buffer.from(file, "latin1");
const nulList = (files: Iterable<GitPath>): Buffer =>
  Buffer.concat([...files].flatMap((file) => [bytesOf(file), NUL]));
const onDisk = (top: string, file: GitPath): Buffer =>
  Buffer.concat([Buffer.from(`${top}/`), bytesOf(file)]);

/** What is at the file's path; undefined when nothing is, a file where its directory was included. */
const statOnDisk = (top: string, file: GitPath): fs.Stats | undefined => {
  try {
    return fs.lstatSync(onDisk(top, file));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTDIR"].includes(String(error.code))
    ) {
      return undefined;
    }
    throw error;
  }
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const octal = (byte: number): string => `\\${byte.toString(8).padStart(3, "0")}`;

const displayPath = (file: GitPath): string => {
  const bytes = bytesOf(file);
  try {
    return UTF8.decode(bytes).replace(/\p{Cc}/gu, (control) =>
      [...Buffer.from(control)].map(octal).join(""),
    );
  } catch {
    return [...bytes]
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : octal(byte)))
      .join("");
  }
};

const nulFields = (bytes: Buffer): ReadonlyArray<Buffer> => {
  const fields: Array<Buffer> = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(0, at);
    const stop = end === -1 ? bytes.length : end;
    if (stop > at) fields.push(bytes.subarray(at, stop));
    at = stop + 1;
  }
  return fields;
};

const wordsAndPath = (
  field: Buffer,
  count: number,
): { readonly words: ReadonlyArray<string>; readonly path: GitPath } => {
  let at = 0;
  for (let seen = 0; seen < count; seen += 1) at = field.indexOf(0x20, at) + 1;
  return {
    words: field
      .subarray(0, at - 1)
      .toString()
      .split(" "),
    path: pathOf(field.subarray(at)),
  };
};

const filtersOff = (git: Git, env: Env): ReadonlyArray<string> => {
  const keys = git.attempt(env, ["config", "--name-only", "--get-regexp", "^filter\\."]) ?? "";
  const names = new Set(
    keys
      .split("\n")
      .filter((key) => key.lastIndexOf(".") > "filter.".length)
      .map((key) => key.slice("filter.".length, key.lastIndexOf("."))),
  );
  return [...names].flatMap((name) => [
    `filter.${name}.clean=`,
    `filter.${name}.process=`,
    `filter.${name}.required=false`,
  ]);
};

interface TrackedEntry {
  readonly kind: "tracked";
  readonly path: GitPath;
  readonly staged: string;
  readonly unstaged: string;
  readonly headMode: string;
  readonly headSha: string;
  readonly indexSha: string;
}

type StatusEntry =
  | TrackedEntry
  | { readonly kind: "untracked"; readonly path: GitPath }
  | { readonly kind: "unmerged"; readonly path: GitPath };

const leadOf = (field: Buffer): string => String.fromCharCode(field[0] ?? 0);
const namesDirectory = (field: Buffer): boolean => field.at(-1) === 0x2f;

const parseStatus = (fields: ReadonlyArray<Buffer>): ReadonlyArray<StatusEntry> =>
  fields.flatMap((field): ReadonlyArray<StatusEntry> => {
    if (leadOf(field) === "1") {
      // 1 XY sub mH mI mW hH hI path
      const { words, path: file } = wordsAndPath(field, 8);
      const xy = words[1] ?? "..";
      return [
        {
          kind: "tracked",
          path: file,
          staged: xy[0] ?? ".",
          unstaged: xy[1] ?? ".",
          headMode: words[3] ?? "000000",
          headSha: words[6] ?? "",
          indexSha: words[7] ?? "",
        },
      ];
    }
    if (leadOf(field) === "u") return [{ kind: "unmerged", path: wordsAndPath(field, 10).path }];
    // An untracked directory is a nested repository; it is not the checkout's to carry.
    if (leadOf(field) === "?" && !namesDirectory(field)) {
      return [{ kind: "untracked", path: pathOf(field.subarray(2)) }];
    }
    return [];
  });

const refused = (message: string): SnapshotOutcome => ({ _tag: "refused", message });

interface CheckoutPaths {
  readonly top: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

const pathsOf = (cwd: string, base: Env): CheckoutPaths | null => {
  const top = gitIn(cwd, SAFE_CONFIG).attempt(base, ["rev-parse", "--show-toplevel"])?.trim() ?? "";
  if (top === "") return null;
  const [gitDir = "", commonDir = ""] = (
    gitIn(top, SAFE_CONFIG).attempt(base, [
      "rev-parse",
      "--absolute-git-dir",
      "--git-common-dir",
    ]) ?? ""
  ).split("\n");
  return { top, gitDir, commonDir: path.resolve(top, commonDir) };
};

export const checkoutOf = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): (CheckoutPaths & { readonly originUrl: string | null }) | null => {
  const base = scrubbed(env);
  const paths = pathsOf(cwd, base);
  if (paths === null) return null;
  const origin =
    gitIn(paths.top, SAFE_CONFIG).attempt(base, ["remote", "get-url", "origin"])?.trim() ?? "";
  return { ...paths, originUrl: origin === "" ? null : origin };
};

const realOrResolved = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

export const scratchParentIssue = (parent: string, checkout: CheckoutPaths): string | null => {
  const scratch = realOrResolved(parent);
  const inside = [checkout.top, checkout.gitDir, checkout.commonDir].some((dir) => {
    const protectedDir = realOrResolved(dir);
    return scratch === protectedDir || scratch.startsWith(`${protectedDir}${path.sep}`);
  });
  return inside
    ? `TMPDIR is ${parent}, inside this checkout, and a handoff writes nothing there · set TMPDIR elsewhere, then hand off again · nothing was created`
    : null;
};

const NO_COMMIT =
  "this branch has no commit yet · commit once, then hand off · nothing was created";

const unmergedRefusal = (paths: number): string =>
  `${paths} unmerged ${paths === 1 ? "path" : "paths"} · finish or abort the merge, then hand off · nothing was created`;

const notACheckout = (dir: string): string =>
  `${dir} is not inside a git checkout · run mend handoff in one · nothing was created`;

interface Opened {
  readonly base: Env;
  readonly paths: CheckoutPaths;
  readonly git: Git;
}

/** The checkout, and the one git every read of it goes through. */
const openCheckout = (dir: string, env: NodeJS.ProcessEnv): Opened | null => {
  const base = scrubbed(env);
  const paths = pathsOf(dir, base);
  if (paths === null) return null;
  const filters = filtersOff(gitIn(paths.top, SAFE_CONFIG), base);
  return { base, paths, git: gitIn(paths.top, [...SAFE_CONFIG, ...filters]) };
};

const headOf = (git: Git, base: Env): string | null =>
  git.attempt(base, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])?.trim() ?? null;

const TRACKING = "refs/remotes/origin/";

const commitAt = (git: Git, base: Env, ref: string): boolean =>
  git.attempt(base, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) !== null;

/**
 * origin's default branch as this checkout knows it: `origin/HEAD` when it names a branch the
 * checkout has. A clone that was never told (`git init` then a push) has none, and one renamed on
 * origin and pruned here names a branch that is gone; adoption clones origin's own HEAD, so the
 * common names stand in for it, in this order.
 */
const originDefaultOf = (git: Git, base: Env): string | { readonly refused: string } => {
  const head = git.attempt(base, ["symbolic-ref", "-q", `${TRACKING}HEAD`])?.trim() ?? "";
  if (head.startsWith(TRACKING) && commitAt(git, base, head)) return head.slice(TRACKING.length);
  const known = ["main", "master"].find((name) => commitAt(git, base, `${TRACKING}${name}`));
  if (known !== undefined) return known;
  const tracked = (git.attempt(base, ["for-each-ref", "--format=%(refname)", TRACKING]) ?? "")
    .split("\n")
    .filter((ref) => ref !== "" && ref !== `${TRACKING}HEAD`);
  return {
    refused:
      tracked.length === 0
        ? "this checkout has fetched no branch from origin · run git fetch origin, then hand off again · nothing was created"
        : "this checkout does not know origin's default branch · run git fetch origin && git remote set-head origin -a, then hand off again · nothing was created",
  };
};

const basesOf = (
  git: Git,
  base: Env,
  head: string,
  defaultBranch: string,
): { readonly defaultTip: string; readonly mergeBase: string } | { readonly refused: string } => {
  const tracking = `${TRACKING}${defaultBranch}`;
  const defaultTip =
    git.attempt(base, ["rev-parse", "--verify", "-q", `${tracking}^{commit}`])?.trim() ?? null;
  if (defaultTip === null) {
    return {
      refused: `this checkout has no origin/${defaultBranch} · run git fetch origin, then hand off again · nothing was created`,
    };
  }
  const mergeBase = git.attempt(base, ["merge-base", head, defaultTip])?.trim() ?? null;
  if (mergeBase === null) {
    return { refused: `HEAD shares no history with origin/${defaultBranch} · nothing was created` };
  }
  return { defaultTip, mergeBase };
};

interface Checkout extends CheckoutPaths {
  readonly objects: string;
  readonly format: string;
  readonly partial: boolean;
  /** `--sparse` for ls-files when the index may be sparse; older git has no such flag. */
  readonly sparseFlag: ReadonlyArray<string>;
  readonly head: string;
  readonly defaultTip: string;
  readonly mergeBase: string;
  readonly localBranch: string | null;
}

const locate = (
  git: Git,
  base: Env,
  paths: CheckoutPaths,
  /** Null reads origin's from the checkout. */
  defaultBranch: string | null,
): Checkout | { readonly refused: string } => {
  const text = (args: ReadonlyArray<string>) => git.run(base, args).toString().trim();
  const head = headOf(git, base);
  if (head === null) return { refused: NO_COMMIT };
  const branch = defaultBranch ?? originDefaultOf(git, base);
  if (typeof branch !== "string") return branch;
  const bases = basesOf(git, base, head, branch);
  if ("refused" in bases) return bases;
  const { defaultTip, mergeBase } = bases;
  const branchRef = git.attempt(base, ["symbolic-ref", "-q", "HEAD"])?.trim() ?? "";
  return {
    ...paths,
    objects: path.resolve(paths.top, text(["rev-parse", "--git-path", "objects"])),
    format: text(["rev-parse", "--show-object-format"]),
    partial:
      (git.attempt(base, ["config", "--get", "extensions.partialClone"]) ?? "").trim() !== "" ||
      (
        git.attempt(base, ["config", "--type=bool", "--get-regexp", "^remote\\..+\\.promisor$"]) ??
        ""
      )
        .split("\n")
        .some((line) => line.endsWith(" true")),
    sparseFlag:
      git.attempt(base, ["config", "--type=bool", "--get", "index.sparse"])?.trim() === "true"
        ? ["--sparse"]
        : [],
    head,
    defaultTip,
    mergeBase,
    localBranch: branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null,
  };
};

interface Scratch {
  readonly dir: string;
  readonly objects: string;
  readonly reads: Env;
  /** No alternates: git freshens an object it writes when any store it can see already has it. */
  readonly writes: (indexFile: string) => Env;
  readonly inRepo: Env;
}

const scratchFor = (git: Git, base: Env, checkout: Checkout, dir: string): Scratch => {
  const shadow = path.join(dir, "shadow");
  fs.mkdirSync(shadow);
  fs.writeFileSync(path.join(shadow, "HEAD"), `${checkout.head}\n`);
  for (const file of fs.readdirSync(checkout.gitDir)) {
    if (file === "index" || file === "config.worktree" || file.startsWith("sharedindex.")) {
      const from = path.join(checkout.gitDir, file);
      // Git rereads a file whose stat matches its entry only when the index is not older than it,
      // so a copy dated now would trust a same-size edit made in the index's own tick. Stat before
      // copying and floor to the second (BigInt division truncates toward zero): an older date only
      // makes git reread more.
      const ns = fs.statSync(from, { bigint: true }).mtimeNs;
      const second = 1_000_000_000n;
      const written = Number(ns / second - (ns % second < 0n ? 1n : 0n));
      fs.copyFileSync(from, path.join(shadow, file));
      fs.utimesSync(path.join(shadow, file), written, written);
    }
  }
  // Without its patterns git takes every checked-out file for one outside them, and expands a
  // sparse index to clear their bits.
  const patterns = path.join(checkout.gitDir, "info", "sparse-checkout");
  if (fs.existsSync(patterns)) {
    fs.mkdirSync(path.join(shadow, "info"));
    fs.copyFileSync(patterns, path.join(shadow, "info", "sparse-checkout"));
  }
  const repo = path.join(dir, "scratch.git");
  git.run(base, [
    "init",
    "--bare",
    "-q",
    "--template=",
    `--object-format=${checkout.format}`,
    repo,
  ]);
  const objects = path.join(repo, "objects");
  const over = (indexFile: string): Env => ({
    ...base,
    GIT_DIR: shadow,
    GIT_COMMON_DIR: checkout.commonDir,
    GIT_WORK_TREE: checkout.top,
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: objects,
  });
  return {
    dir,
    objects,
    reads: {
      ...over(path.join(shadow, "index")),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: checkout.objects,
    },
    writes: over,
    inRepo: { ...base, GIT_DIR: repo },
  };
};

export interface PreflightRequest {
  readonly checkout: string;
  readonly scratch: string;
  readonly env?: NodeJS.ProcessEnv;
}

const preflight = (request: PreflightRequest): string | null => {
  const opened = openCheckout(request.checkout, request.env ?? process.env);
  if (opened === null) return notACheckout(request.checkout);
  const { base, git, paths } = opened;
  const checkout = locate(git, base, paths, null);
  if ("refused" in checkout) return checkout.refused;
  const { reads } = scratchFor(git, base, checkout, request.scratch);
  const unmerged = new Set(
    nulFields(git.run(reads, ["ls-files", "--unmerged", "-z", ...checkout.sparseFlag])).map(
      (field) => pathOf(field.subarray(field.indexOf(TAB) + 1)),
    ),
  );
  return unmerged.size === 0 ? null : unmergedRefusal(unmerged.size);
};

/**
 * What a snapshot of this checkout would refuse, read the way a snapshot reads it, before any
 * server knows a default branch: no commit, no default branch of origin's, no shared history,
 * unmerged paths. Null when none applies.
 */
export const preflightIssue = (request: PreflightRequest): string | null => {
  try {
    return preflight(request);
  } catch (error) {
    if (error instanceof GitFailure) return `${error.message} · nothing was created`;
    throw error;
  }
};

type Excluded =
  | { readonly path: GitPath; readonly reason: "env" }
  | { readonly path: GitPath; readonly reason: "over-limit"; readonly bytes: number }
  | { readonly path: GitPath; readonly reason: "filter"; readonly filter: string };

interface Inspection {
  readonly tracked: ReadonlyArray<TrackedEntry>;
  readonly untracked: ReadonlyArray<GitPath>;
  readonly intentToAdd: ReadonlySet<GitPath>;
  readonly leftOut: ReadonlyArray<Excluded>;
  readonly stays: ReadonlySet<GitPath>;
  readonly committedEnv: ReadonlyArray<CommittedEnv>;
  readonly hidden: ReadonlyArray<{ readonly path: GitPath; readonly bit: HiddenBit }>;
  readonly commitsAhead: number;
}

const TREE_MODE = "040000";

/**
 * Git expanding a sparse index rewrites its trees and freshens the checkout's copies, so `--sparse`
 * keeps each sparse directory and its tree is listed by reads alone.
 */
const indexEntries = (git: Git, checkout: Checkout, reads: Env): Buffer =>
  Buffer.concat(
    nulFields(git.run(reads, ["ls-files", "-s", "-z", ...checkout.sparseFlag])).flatMap((field) => {
      const tab = field.indexOf(TAB);
      const [mode = "", tree = ""] = field.subarray(0, tab).toString().split(" ");
      if (mode !== TREE_MODE) return [field, NUL];
      const dir = field.subarray(tab + 1);
      return nulFields(git.run(reads, ["ls-tree", "-r", "-z", "--full-tree", tree])).flatMap(
        (line) => {
          const at = line.indexOf(TAB);
          const [entryMode = "", , sha = ""] = line.subarray(0, at).toString().split(" ");
          return [Buffer.from(`${entryMode} ${sha} 0\t`), dir, line.subarray(at + 1), NUL];
        },
      );
    }),
  );

// `ls-files -v`: lowercase is assume-unchanged, S skip-worktree.
const HIDDEN_BY_TAG: ReadonlyMap<string, HiddenBit> = new Map([
  ["h", "assume-unchanged"],
  ["S", "skip-worktree"],
  ["s", "assume-unchanged and skip-worktree"],
]);

/**
 * assume-unchanged and skip-worktree hide an edit from git status; the bits are cleared on the
 * shadow index so status sees it. The files on disk that carried one, with the bit.
 */
const revealHiddenEdits = (
  git: Git,
  checkout: Checkout,
  reads: Env,
): ReadonlyMap<GitPath, HiddenBit> => {
  const listing = git.run(reads, ["ls-files", "-v", "-z", ...checkout.sparseFlag]);
  const hidden = new Map(
    nulFields(listing).flatMap((field): ReadonlyArray<readonly [GitPath, HiddenBit]> => {
      const bit = HIDDEN_BY_TAG.get(leadOf(field));
      if (bit === undefined || namesDirectory(field)) return [];
      const file = pathOf(field.subarray(2));
      return statOnDisk(checkout.top, file) === undefined ? [] : [[file, bit]];
    }),
  );
  if (hidden.size > 0) {
    // One bit per call: update-index applies only the first of the two to each path.
    for (const bit of ["--no-assume-unchanged", "--no-skip-worktree"]) {
      git.run(reads, ["update-index", bit, "-z", "--stdin"], nulList(hidden.keys()));
    }
  }
  return hidden;
};

const committedEnvOf = (git: Git, base: Env, checkout: Checkout): ReadonlyArray<CommittedEnv> =>
  git
    .run(base, [
      "log",
      "--no-show-signature",
      "--no-renames",
      "--diff-filter=d",
      // A merge's own changes, against every parent, so a file only the merge brought is named.
      "--cc",
      "--name-only",
      "-z",
      "--format=%x01%H",
      `${checkout.mergeBase}..${checkout.head}`,
    ])
    .toString("latin1")
    .split("\x01")
    .flatMap((record) => {
      const [commit = "", ...paths] = record.split("\0");
      return paths
        .map((file) => GitPath.make(file.replace(/^\n/u, "")))
        .filter((file) => file !== "" && isEnvPath(displayPath(file)))
        .map((file) => ({ path: displayPath(file), commit: commit.slice(0, 7) }));
    });

const inspect = (
  git: Git,
  checkout: Checkout,
  base: Env,
  reads: Env,
  maxFileBytes: number,
): Inspection | { readonly refused: string } => {
  const hiddenBits = revealHiddenEdits(git, checkout, reads);
  const status = parseStatus(
    nulFields(
      git.run(reads, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--no-renames",
        "--ignore-submodules=dirty",
      ]),
    ),
  );
  const unmerged = status.filter((entry) => entry.kind === "unmerged");
  if (unmerged.length > 0) {
    return { refused: unmergedRefusal(unmerged.length) };
  }
  const tracked = status.flatMap((entry) => (entry.kind === "tracked" ? [entry] : []));
  const untracked = status.flatMap((entry) => (entry.kind === "untracked" ? [entry.path] : []));
  const intentToAdd = new Set(
    tracked.filter((entry) => entry.staged === "." && entry.unstaged === "A").map((e) => e.path),
  );

  const candidates = [...tracked.map((entry) => entry.path), ...untracked];
  const filters = new Map<GitPath, string>();
  if (candidates.length > 0) {
    const attrs = nulFields(
      git.run(reads, ["check-attr", "-z", "--stdin", "filter"], nulList(candidates)),
    );
    for (let at = 0; at + 2 < attrs.length; at += 3) {
      const value = attrs[at + 2]?.toString() ?? "unspecified";
      if (!["unspecified", "unset", "set"].includes(value)) {
        filters.set(pathOf(attrs[at] ?? Buffer.alloc(0)), value);
      }
    }
  }
  const stagedBlobs = tracked.filter((entry) => entry.staged !== "." && entry.staged !== "D");
  const indexSizes = new Map<GitPath, number>();
  if (stagedBlobs.length > 0) {
    const sizes = git
      .run(
        reads,
        ["cat-file", "--batch-check=%(objectsize)"],
        `${stagedBlobs.map((entry) => entry.indexSha).join("\n")}\n`,
      )
      .toString()
      .split("\n");
    stagedBlobs.forEach((entry, at) => indexSizes.set(entry.path, Number(sizes[at])));
  }
  const workingSize = (file: GitPath): number => {
    const stat = statOnDisk(checkout.top, file);
    return stat?.isFile() === true ? stat.size : 0;
  };
  const excludedOf = (file: GitPath): Excluded | null => {
    if (isEnvPath(displayPath(file))) return { path: file, reason: "env" };
    const filter = filters.get(file);
    if (filter !== undefined) return { path: file, reason: "filter", filter };
    const bytes = Math.max(indexSizes.get(file) ?? 0, workingSize(file));
    return bytes > maxFileBytes ? { path: file, reason: "over-limit", bytes } : null;
  };
  const leftOut = candidates.flatMap((file) => {
    const out = excludedOf(file);
    return out === null ? [] : [out];
  });
  const stays = new Set(leftOut.map((out) => out.path));
  const ignoredEnv = nulFields(
    git.run(reads, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
    ]),
  ).flatMap((field): ReadonlyArray<Excluded> => {
    const file = pathOf(field);
    return !namesDirectory(field) && isEnvPath(displayPath(file))
      ? [{ path: file, reason: "env" }]
      : [];
  });

  return {
    tracked,
    untracked,
    intentToAdd,
    leftOut: [...leftOut, ...ignoredEnv],
    stays,
    committedEnv: committedEnvOf(git, base, checkout),
    hidden: tracked.flatMap((entry) => {
      const bit = hiddenBits.get(entry.path);
      return bit === undefined || entry.unstaged === "." || stays.has(entry.path)
        ? []
        : [{ path: entry.path, bit }];
    }),
    commitsAhead: Number(
      git
        .run(base, ["rev-list", "--count", `${checkout.mergeBase}..${checkout.head}`])
        .toString()
        .trim(),
    ),
  };
};

interface Trees {
  readonly indexTree: string;
  readonly worktreeTree: string;
}

const headPins = (inspection: Inspection, zeros: string): ReadonlyArray<Buffer> =>
  inspection.tracked
    .filter((entry) => inspection.stays.has(entry.path) || inspection.intentToAdd.has(entry.path))
    .map((entry) =>
      Buffer.concat([
        Buffer.from(
          inspection.intentToAdd.has(entry.path) || /^0+$/u.test(entry.headMode)
            ? `0 ${zeros} 0\t`
            : `${entry.headMode} ${entry.headSha} 0\t`,
        ),
        bytesOf(entry.path),
        NUL,
      ]),
    );

const buildTrees = (
  git: Git,
  checkout: Checkout,
  inspection: Inspection,
  scratch: Scratch,
): Trees => {
  const indexFile = path.join(scratch.dir, "index");
  const writes = scratch.writes(indexFile);
  git.run(
    writes,
    ["update-index", "-z", "--index-info"],
    indexEntries(git, checkout, scratch.reads),
  );
  const pins = headPins(inspection, "0".repeat(checkout.head.length));
  if (pins.length > 0) git.run(writes, ["update-index", "-z", "--index-info"], Buffer.concat(pins));
  const indexTree = git.run(writes, ["write-tree", "--missing-ok"]).toString().trim();

  const worktreeFile = path.join(scratch.dir, "worktree-index");
  fs.copyFileSync(indexFile, worktreeFile);
  const onTop = scratch.writes(worktreeFile);
  const travels = (file: GitPath) => !inspection.stays.has(file);
  const removed = inspection.tracked
    .filter((entry) => entry.unstaged === "D" && travels(entry.path))
    .map((entry) => entry.path);
  const added = [
    ...inspection.tracked
      .filter((entry) => entry.unstaged !== "." && entry.unstaged !== "D" && travels(entry.path))
      .map((entry) => entry.path),
    ...inspection.untracked.filter(travels),
  ];
  if (removed.length > 0) {
    git.run(onTop, ["update-index", "-z", "--force-remove", "--stdin"], nulList(removed));
  }
  if (added.length > 0) git.run(onTop, ["update-index", "-z", "--add", "--stdin"], nulList(added));
  return {
    indexTree,
    worktreeTree: git.run(onTop, ["write-tree", "--missing-ok"]).toString().trim(),
  };
};

interface Bundle {
  readonly index: string;
  readonly worktree: string;
  readonly bundlePath: string;
}

const bundleOf = (
  git: Git,
  checkout: Checkout,
  trees: Trees,
  scratch: Scratch,
  request: SnapshotRequest,
): Bundle => {
  const seconds = Math.floor(request.cutAt.getTime() / 1000);
  const ident = `mend <mend@mend.invalid> ${seconds} +0000`;
  const writes = scratch.writes(path.join(scratch.dir, "index"));
  // Not commit-tree: it must read the parent, which writes() hides, and it signs under
  // commit.gpgSign.
  const writeCommit = (tree: string, parent: string, message: string): string =>
    git
      .run(
        writes,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        [
          `tree ${tree}`,
          `parent ${parent}`,
          `author ${ident}`,
          `committer ${ident}`,
          "",
          message,
        ].join("\n"),
      )
      .toString()
      .trim();
  const index = writeCommit(trees.indexTree, checkout.head, "mend handoff index\n");
  const trailers = Schema.decodeUnknownSync(HandoffTrailers)({
    machine: request.machine,
    localBranch: checkout.localBranch,
    cutAt: request.cutAt.toISOString(),
    defaultTip: checkout.defaultTip,
    mergeBase: checkout.mergeBase,
  });
  const worktree = writeCommit(trees.worktreeTree, index, formatHandoffMessage(trailers));

  fs.mkdirSync(path.join(scratch.objects, "info"), { recursive: true });
  fs.writeFileSync(path.join(scratch.objects, "info", "alternates"), `${checkout.objects}\n`);
  git.run(scratch.inRepo, ["update-ref", HANDOFF_SNAPSHOT_REF, worktree]);
  const bundlePath = path.join(scratch.dir, "handoff.bundle");
  git.run(scratch.inRepo, [
    "bundle",
    "create",
    "-q",
    bundlePath,
    HANDOFF_SNAPSHOT_REF,
    `^${checkout.mergeBase}`,
  ]);
  return { index, worktree, bundlePath };
};

const leftOutFor = (out: Excluded): LeftOut => ({ ...out, path: displayPath(out.path) });

const cutSnapshot = (request: SnapshotRequest): SnapshotOutcome => {
  const opened = openCheckout(request.checkout, request.env ?? process.env);
  if (opened === null) return refused(notACheckout(request.checkout));
  const { base, git, paths } = opened;
  const checkout = locate(git, base, paths, request.defaultBranch);
  if ("refused" in checkout) return refused(checkout.refused);
  try {
    const scratch = scratchFor(git, base, checkout, request.scratch);
    const inspection = inspect(git, checkout, base, scratch.reads, request.maxFileBytes);
    if ("refused" in inspection) return refused(inspection.refused);
    const trees = buildTrees(git, checkout, inspection, scratch);
    const bundle = bundleOf(git, checkout, trees, scratch, request);
    const travels = (file: GitPath) => !inspection.stays.has(file);
    return {
      _tag: "snapshot",
      snapshot: {
        head: checkout.head,
        index: bundle.index,
        worktree: bundle.worktree,
        mergeBase: checkout.mergeBase,
        defaultTip: checkout.defaultTip,
        localBranch: checkout.localBranch,
        facts: {
          commitsAhead: inspection.commitsAhead,
          uncommitted: inspection.tracked.filter((entry) => travels(entry.path)).length,
          untracked: inspection.untracked.filter(travels).length,
        },
        leftOut: inspection.leftOut.map(leftOutFor),
        committedEnv: inspection.committedEnv,
        hidden: inspection.hidden.map((file) => ({ ...file, path: displayPath(file.path) })),
        bundlePath: bundle.bundlePath,
        bundleBytes: fs.statSync(bundle.bundlePath).size,
        cutAt: request.cutAt.toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof GitFailure && checkout.partial) {
      return refused(
        `this partial clone lacks objects a handoff reads, and mend handoff never fetches · git log -p ${checkout.mergeBase.slice(0, 7)}..HEAD fetches them, then hand off again · git said: ${error.words} · nothing was created`,
      );
    }
    throw error;
  }
};

export const snapshotCheckout = (request: SnapshotRequest): SnapshotOutcome => {
  try {
    return cutSnapshot(request);
  } catch (error) {
    if (error instanceof GitFailure) return refused(`${error.message} · nothing was created`);
    throw error;
  }
};
