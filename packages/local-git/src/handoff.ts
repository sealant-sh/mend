import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatHandoffMessage,
  HANDOFF_SNAPSHOT_REF,
  HandoffTrailers,
  isEnvPath,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import {
  type Cancelled,
  type Env,
  type Git,
  GitFailure,
  gitIn,
  type GitRuntime,
  type Refused,
  refused,
  type Runtime,
  runtimeOf,
  SAFE_CONFIG,
  scrubbed,
  settled,
} from "./git.ts";
import {
  bytesOf,
  displayPath,
  GitPath,
  leadOf,
  namesDirectory,
  NUL,
  nulFields,
  nulList,
  parseStatus,
  pathOf,
  statOnDisk,
  TAB,
  type TrackedEntry,
} from "./paths.ts";

export { type Cancelled, HANDOFF_GIT_TIMEOUT_MS, type GitRuntime, type Refused } from "./git.ts";

/** Whether uncommitted `.env*` edits travel. Gitignored ones never do. */
export type EnvFiles = "exclude" | "include";

export type LeftOut =
  | { readonly path: string; readonly reason: "env" }
  | { readonly path: string; readonly reason: "ignored-env" }
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

export interface CaptureSummary {
  readonly head: string;
  readonly index: string;
  readonly worktree: string;
  readonly mergeBase: string;
  readonly defaultTip: string;
  readonly defaultBranch: string;
  readonly localBranch: string | null;
  readonly facts: HandoffFacts;
  readonly leftOut: ReadonlyArray<LeftOut>;
  readonly committedEnv: ReadonlyArray<CommittedEnv>;
  readonly hidden: ReadonlyArray<Hidden>;
  readonly cutAt: string;
  readonly envFiles: EnvFiles;
}

export interface CaptureRequest {
  readonly checkout: string;
  /** Null takes origin's default branch as this checkout knows it. */
  readonly defaultBranch: string | null;
  readonly machine: string;
  readonly maxFileBytes: number;
  readonly envFiles: EnvFiles;
  readonly cutAt: Date;
  /** The capture makes its private directory here; dispose removes it. */
  readonly scratchParent: string;
  readonly runtime?: GitRuntime;
}

export type PackOutcome =
  | { readonly _tag: "packed"; readonly bundlePath: string; readonly bundleBytes: number }
  | Refused
  | Cancelled;

export interface CapturedCheckout {
  readonly summary: CaptureSummary;
  /** Packs once; later calls return the first outcome. */
  readonly pack: () => PackOutcome;
  /** Removes the capture's directory, the bundle included. */
  readonly dispose: () => void;
}

export type CaptureOutcome =
  | { readonly _tag: "captured"; readonly capture: CapturedCheckout }
  | Refused
  | Cancelled;

const filtersOff = (git: Git, env: Env): ReadonlyArray<string> => {
  const keys = git.attempt(env, ["config", "--name-only", "--get-regexp", "^filter\\."], 1) ?? "";
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

interface CheckoutPaths {
  readonly top: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

const pathsOf = (cwd: string, base: Env, runtime: Runtime): CheckoutPaths | null => {
  const top =
    gitIn(cwd, SAFE_CONFIG, runtime)
      .attempt(base, ["rev-parse", "--show-toplevel"], 128, "not a git repository")
      ?.trim() ?? "";
  if (top === "") return null;
  const [gitDir = "", commonDir = ""] = gitIn(top, SAFE_CONFIG, runtime)
    .run(base, ["rev-parse", "--absolute-git-dir", "--git-common-dir"])
    .toString()
    .split("\n");
  return { top, gitDir, commonDir: path.resolve(top, commonDir) };
};

export interface LocalCheckout extends CheckoutPaths {
  readonly originUrl: string | null;
}

export type CheckoutOutcome =
  | { readonly _tag: "checkout"; readonly checkout: LocalCheckout }
  | Refused
  | Cancelled;

export const checkoutOf = (cwd: string, runtime?: GitRuntime): CheckoutOutcome =>
  settled(() => {
    const resolved = runtimeOf(runtime);
    const base = scrubbed(resolved.env);
    const paths = pathsOf(cwd, base, resolved);
    if (paths === null) return refused(notACheckout(cwd));
    const origin =
      gitIn(paths.top, SAFE_CONFIG, resolved)
        .attempt(base, ["remote", "get-url", "origin"], 2)
        ?.trim() ?? "";
    return { _tag: "checkout", checkout: { ...paths, originUrl: origin === "" ? null : origin } };
  });

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

const scratchUnder = (parent: string, checkout: CheckoutPaths): string | Refused => {
  const issue = scratchParentIssue(parent, checkout);
  if (issue !== null) return refused(issue);
  const dir = fs.mkdtempSync(path.join(parent, "mend-handoff-"));
  if ((fs.statSync(dir).mode & 0o077) !== 0) {
    removeScratch(dir);
    return refused(
      `the directory a handoff made under ${parent} was readable by others · nothing was created`,
    );
  }
  return dir;
};

const removeScratch = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

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
const openCheckout = (dir: string, runtime: Runtime): Opened | null => {
  const base = scrubbed(runtime.env);
  const paths = pathsOf(dir, base, runtime);
  if (paths === null) return null;
  const filters = filtersOff(gitIn(paths.top, SAFE_CONFIG, runtime), base);
  return { base, paths, git: gitIn(paths.top, [...SAFE_CONFIG, ...filters], runtime) };
};

const headOf = (git: Git, base: Env): string | null =>
  git.attempt(base, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], 1)?.trim() ?? null;

const TRACKING = "refs/remotes/origin/";

const commitAt = (git: Git, base: Env, ref: string): boolean =>
  git.attempt(base, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], 1) !== null;

/**
 * origin's default branch as this checkout knows it: `origin/HEAD` when it names a branch the
 * checkout has. A clone that was never told (`git init` then a push) has none, and one renamed on
 * origin and pruned here names a branch that is gone; adoption clones origin's own HEAD, so the
 * common names stand in for it, in this order.
 */
const originDefaultOf = (git: Git, base: Env): string | { readonly refused: string } => {
  const head = git.attempt(base, ["symbolic-ref", "-q", `${TRACKING}HEAD`], 1)?.trim() ?? "";
  if (head.startsWith(TRACKING) && commitAt(git, base, head)) return head.slice(TRACKING.length);
  const known = ["main", "master"].find((name) => commitAt(git, base, `${TRACKING}${name}`));
  if (known !== undefined) return known;
  const tracked = git
    .run(base, ["for-each-ref", "--format=%(refname)", TRACKING])
    .toString()
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
    git.attempt(base, ["rev-parse", "--verify", "-q", `${tracking}^{commit}`], 1)?.trim() ?? null;
  if (defaultTip === null) {
    return {
      refused: `this checkout has no origin/${defaultBranch} · run git fetch origin, then hand off again · nothing was created`,
    };
  }
  const mergeBase = git.attempt(base, ["merge-base", head, defaultTip], 1)?.trim() ?? null;
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
  readonly defaultBranch: string;
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
  const branchRef = git.attempt(base, ["symbolic-ref", "-q", "HEAD"], 1)?.trim() ?? "";
  return {
    ...paths,
    objects: path.resolve(paths.top, text(["rev-parse", "--git-path", "objects"])),
    format: text(["rev-parse", "--show-object-format"]),
    partial:
      (git.attempt(base, ["config", "--get", "extensions.partialClone"], 1) ?? "").trim() !== "" ||
      (
        git.attempt(
          base,
          ["config", "--type=bool", "--get-regexp", "^remote\\..+\\.promisor$"],
          1,
        ) ?? ""
      )
        .split("\n")
        .some((line) => line.endsWith(" true")),
    sparseFlag:
      git.attempt(base, ["config", "--type=bool", "--get", "index.sparse"], 1)?.trim() === "true"
        ? ["--sparse"]
        : [],
    head,
    defaultBranch: branch,
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
      // Git rereads a file whose stat matches its entry only when the index is not newer than it,
      // so a copy dated now would trust a same-size edit made in the index's own tick. Stat before
      // copying and floor to the second: an older date only makes git reread more. Git keeps those
      // seconds in 32 bits; outside them the copy is dated 1 s after the epoch, so git rereads all.
      const ns = fs.statSync(from, { bigint: true }).mtimeNs;
      const seconds = ns / 1_000_000_000n - (ns % 1_000_000_000n < 0n ? 1n : 0n);
      const written = seconds >= 0n && seconds < 2n ** 32n ? Number(seconds) : 1;
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
  readonly scratchParent: string;
  readonly runtime?: GitRuntime;
}

export type PreflightOutcome = { readonly _tag: "clear" } | Refused | Cancelled;

const preflight = (request: PreflightRequest, runtime: Runtime): PreflightOutcome => {
  const opened = openCheckout(request.checkout, runtime);
  if (opened === null) return refused(notACheckout(request.checkout));
  const { base, git, paths } = opened;
  const checkout = locate(git, base, paths, null);
  if ("refused" in checkout) return refused(checkout.refused);
  const dir = scratchUnder(request.scratchParent, checkout);
  if (typeof dir !== "string") return dir;
  try {
    const { reads } = scratchFor(git, base, checkout, dir);
    const unmerged = new Set(
      nulFields(git.run(reads, ["ls-files", "--unmerged", "-z", ...checkout.sparseFlag])).map(
        (field) => pathOf(field.subarray(field.indexOf(TAB) + 1)),
      ),
    );
    return unmerged.size === 0 ? { _tag: "clear" } : refused(unmergedRefusal(unmerged.size));
  } finally {
    removeScratch(dir);
  }
};

/**
 * What a capture of this checkout would refuse, read the way a capture reads it, before any
 * server knows a default branch: no commit, no default branch of origin's, no shared history,
 * unmerged paths.
 */
export const preflightIssue = (request: PreflightRequest): PreflightOutcome =>
  settled(() => preflight(request, runtimeOf(request.runtime)));

type Excluded =
  | { readonly path: GitPath; readonly reason: "env" }
  | { readonly path: GitPath; readonly reason: "ignored-env" }
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
  envFiles: EnvFiles,
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
    if (envFiles === "exclude" && isEnvPath(displayPath(file))) {
      return { path: file, reason: "env" };
    }
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
      ? [{ path: file, reason: "ignored-env" }]
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

interface Commits {
  readonly index: string;
  readonly worktree: string;
}

const commitsOf = (
  git: Git,
  checkout: Checkout,
  trees: Trees,
  scratch: Scratch,
  request: CaptureRequest,
): Commits => {
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
  return {
    index,
    worktree: writeCommit(trees.worktreeTree, index, formatHandoffMessage(trailers)),
  };
};

const missingObjects = (checkout: Checkout, error: unknown): Refused | null =>
  error instanceof GitFailure && checkout.partial
    ? refused(
        `this partial clone lacks objects a handoff reads, and mend handoff never fetches · git log -p ${checkout.mergeBase.slice(0, 7)}..HEAD fetches them, then hand off again · git said: ${error.words} · nothing was created`,
      )
    : null;

const bundleOf = (
  git: Git,
  checkout: Checkout,
  scratch: Scratch,
  worktree: string,
): PackOutcome => {
  try {
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
    return { _tag: "packed", bundlePath, bundleBytes: fs.statSync(bundlePath).size };
  } catch (error) {
    const missing = missingObjects(checkout, error);
    if (missing !== null) return missing;
    throw error;
  }
};

type Held =
  | { readonly _tag: "held" }
  | { readonly _tag: "packed"; readonly outcome: PackOutcome }
  | { readonly _tag: "disposed" };

const heldCapture = (
  git: Git,
  checkout: Checkout,
  scratch: Scratch,
  summary: CaptureSummary,
): CapturedCheckout => {
  let state: Held = { _tag: "held" };
  const dispose = () => {
    removeScratch(scratch.dir);
    state = { _tag: "disposed" };
  };
  return {
    summary,
    pack: () => {
      if (state._tag === "disposed") throw new Error("this capture was disposed before its pack");
      if (state._tag === "packed") return state.outcome;
      let outcome: PackOutcome;
      try {
        outcome = settled(() => bundleOf(git, checkout, scratch, summary.worktree));
      } catch (error) {
        dispose();
        throw error;
      }
      if (outcome._tag !== "packed") removeScratch(scratch.dir);
      state = { _tag: "packed", outcome };
      return outcome;
    },
    dispose,
  };
};

const leftOutFor = (out: Excluded): LeftOut => ({ ...out, path: displayPath(out.path) });

const capture = (request: CaptureRequest, runtime: Runtime): CaptureOutcome => {
  const opened = openCheckout(request.checkout, runtime);
  if (opened === null) return refused(notACheckout(request.checkout));
  const { base, git, paths } = opened;
  const checkout = locate(git, base, paths, request.defaultBranch);
  if ("refused" in checkout) return refused(checkout.refused);
  const dir = scratchUnder(request.scratchParent, checkout);
  if (typeof dir !== "string") return dir;
  let kept = false;
  try {
    const scratch = scratchFor(git, base, checkout, dir);
    const inspection = inspect(
      git,
      checkout,
      base,
      scratch.reads,
      request.maxFileBytes,
      request.envFiles,
    );
    if ("refused" in inspection) return refused(inspection.refused);
    const trees = buildTrees(git, checkout, inspection, scratch);
    const commits = commitsOf(git, checkout, trees, scratch, request);
    const travels = (file: GitPath) => !inspection.stays.has(file);
    const summary: CaptureSummary = {
      head: checkout.head,
      index: commits.index,
      worktree: commits.worktree,
      mergeBase: checkout.mergeBase,
      defaultTip: checkout.defaultTip,
      defaultBranch: checkout.defaultBranch,
      localBranch: checkout.localBranch,
      facts: {
        commitsAhead: inspection.commitsAhead,
        uncommitted: inspection.tracked.filter((entry) => travels(entry.path)).length,
        untracked: inspection.untracked.filter(travels).length,
      },
      leftOut: inspection.leftOut.map(leftOutFor),
      committedEnv: inspection.committedEnv,
      hidden: inspection.hidden.map((file) => ({ ...file, path: displayPath(file.path) })),
      cutAt: request.cutAt.toISOString(),
      envFiles: request.envFiles,
    };
    kept = true;
    const gitInScratch = gitIn(scratch.dir, SAFE_CONFIG, runtime);
    return { _tag: "captured", capture: heldCapture(gitInScratch, checkout, scratch, summary) };
  } catch (error) {
    const missing = missingObjects(checkout, error);
    if (missing !== null) return missing;
    throw error;
  } finally {
    if (!kept) removeScratch(dir);
  }
};

/**
 * Reads the checkout and never writes to it: the I and W commits go into a private directory
 * under `scratchParent` that lives until `dispose()`.
 */
export const captureCheckout = (request: CaptureRequest): CaptureOutcome =>
  settled(() => capture(request, runtimeOf(request.runtime)));

export const machineName = (hostname: string = os.hostname()): string => {
  const name = [
    ...hostname
      .replace(/\.local$/iu, "")
      .replace(/\p{Cc}/gu, "")
      .trim(),
  ]
    .slice(0, 64)
    .join("")
    .trim();
  return name === "" ? "this machine" : name;
};
