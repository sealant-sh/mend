import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Sha } from "@mend/domain";
import { Effect, Schema } from "effect";

import { git, GitError, gitOutput } from "./git.ts";

/**
 * Landing's git half (docs/adr/0007-landing.md, steps 2 and 3 and "Pulling a change into your own
 * checkout"): the commit for what the agent left uncommitted, the fast-forward-only push, the
 * probe of origin's branch, and the bundle `mend pull` fetches. Every function runs in a git
 * directory, either the project's bare store or a runner cache (ADR 0002), and never in a
 * worktree, so a worktree's files, index and HEAD are never touched here. Credentials arrive as
 * the resolved `remoteEnv` of the project's `gitAuthMode` (`resolveRemoteEnv`); nothing here
 * decides them.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Who Mend's commit is by: the session's owner, as author and committer. */
export interface LandingAuthor {
  readonly name: string;
  readonly email: string;
}

export interface LandingCommitInput {
  /** What Mend's commit is parented on: the session branch's head (a ref or a sha). */
  readonly parent: string;
  /** The checkpoint whose tree is landed (a ref or a sha). */
  readonly checkpoint: string;
  readonly author: LandingAuthor;
  /** The whole message, trailers included (`Mend-Session: …`). */
  readonly message: string;
}

export interface LandedCommit {
  readonly sha: Sha;
  readonly tree: Sha;
  readonly parent: Sha;
}

export interface LandingCommit {
  /** The branch head after landing: Mend's commit, or the parent when nothing was left over. */
  readonly head: Sha;
  /** Mend's commit, or null when the agent's own commits already hold the checkpoint's tree. */
  readonly written: LandedCommit | null;
}

export interface PushInput {
  /** Where to push: `origin` from the project's store, the origin URL from a runner cache. */
  readonly remote: string;
  /** The commit to publish (a ref or a sha). */
  readonly sha: string;
  /** The branch on origin, without `refs/heads/` (`mend/fix-login`). */
  readonly remoteBranch: string;
  readonly remoteEnv: Record<string, string>;
}

export interface Pushed {
  readonly remoteBranch: string;
  readonly pushedSha: Sha;
  /** Origin had no such branch before this push. */
  readonly created: boolean;
  /** Origin's branch already was this commit, so nothing was sent. */
  readonly upToDate: boolean;
}

export interface ProbeInput {
  readonly remote: string;
  readonly remoteBranch: string;
  /** The commit origin's branch is compared with: the landed commit, or the branch head. */
  readonly sha: string;
  readonly remoteEnv: Record<string, string>;
}

/** Origin's branch against one local commit, as a fetch observed it. */
export interface RemoteBranchState {
  readonly remoteBranch: string;
  /** Origin's tip, or null when origin has no such branch. */
  readonly remoteSha: Sha | null;
  /** Commits on origin's branch that `sha` lacks: "origin has moved" when above 0. */
  readonly unseen: number;
  /** Commits of `sha` that origin's branch lacks; null when origin has no such branch. */
  readonly ahead: number | null;
  /** Origin's branch contains `sha`: the landed commit is on origin. */
  readonly holds: boolean;
}

export interface BundleInput {
  /** The session's base. The recipient has it; the bundle carries what follows it. */
  readonly base: string;
  /** The commit the bundle's branch points at (a ref or a sha). */
  readonly tip: string;
  /** The branch the bundle names, without `refs/heads/` (`mend/fix-login`). */
  readonly branch: string;
  /** The largest bundle handed back; a larger one is refused with its size. */
  readonly limitBytes: number;
}

export interface ChangeBundle {
  readonly branch: string;
  readonly base: Sha;
  readonly tip: Sha;
  /** Commits the bundle carries (`base..tip`). */
  readonly commits: number;
  readonly bytes: Uint8Array;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A branch name git would not accept under `refs/heads/`. */
export class InvalidBranchError extends Schema.TaggedErrorClass<InvalidBranchError>()(
  "InvalidBranchError",
  { branch: Schema.String },
) {}

/** The session branch is no longer where the caller observed it, so Mend wrote nothing. */
export class LandingBranchMovedError extends Schema.TaggedErrorClass<LandingBranchMovedError>()(
  "LandingBranchMovedError",
  {
    branch: Schema.String,
    expected: Schema.String,
    actual: Schema.NullOr(Schema.String),
  },
) {}

/**
 * Why origin did not take the push. `diverged`: origin's branch has commits the pushed commit
 * lacks, and Mend never force-pushes. `rejected`: the remote refused the ref (branch protection,
 * a hook). `denied`: the credential may not write to the repository.
 */
export const PushRefusal = Schema.Literals(["diverged", "rejected", "denied"]);
export type PushRefusal = typeof PushRefusal.Type;

export class PushRefusedError extends Schema.TaggedErrorClass<PushRefusedError>()(
  "PushRefusedError",
  {
    remoteBranch: Schema.String,
    reason: PushRefusal,
    /** The remote's own words (its `remote:` lines), then git's status for the ref. */
    message: Schema.String,
    /** Origin's tip when the refusal was `diverged` and a probe read it. */
    remoteSha: Schema.NullOr(Schema.String),
    /** Commits on origin the pushed commit lacks, when a probe counted them. */
    unseen: Schema.NullOr(Schema.Int),
  },
) {}

export class BundleTooLargeError extends Schema.TaggedErrorClass<BundleTooLargeError>()(
  "BundleTooLargeError",
  { branch: Schema.String, size: Schema.Int, limit: Schema.Int },
) {}

/** `base..tip` holds no commit, so there is nothing to pull. */
export class BundleEmptyError extends Schema.TaggedErrorClass<BundleEmptyError>()(
  "BundleEmptyError",
  { branch: Schema.String, base: Schema.String, tip: Schema.String },
) {}

// ─── Helpers ────────────────────────────────────────────────────────────────

const commitOf = (dir: string, rev: string) =>
  git(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], dir).pipe(
    Effect.map(Sha.make),
  );

const treeOf = (dir: string, rev: string) =>
  git(["rev-parse", "--verify", "--end-of-options", `${rev}^{tree}`], dir).pipe(
    Effect.map(Sha.make),
  );

/** `refs/heads/<branch>` is a ref git accepts; the name never reaches git as an option. */
export const checkBranch = (branch: string): Effect.Effect<string, InvalidBranchError> =>
  git(["check-ref-format", `refs/heads/${branch}`], os.tmpdir()).pipe(
    Effect.as(`refs/heads/${branch}`),
    Effect.mapError(() => new InvalidBranchError({ branch })),
  );

/** The `remote:` lines of a push's stderr, prefix removed: what the remote itself said. */
export const remoteWords = (stderr: string): ReadonlyArray<string> =>
  stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter((line) => line !== "");

/** One `push --porcelain` ref line: `<flag>\t<from>:<to>\t<summary>`. */
export interface PorcelainRef {
  readonly flag: string;
  readonly to: string;
  readonly summary: string;
}

export const parsePushPorcelain = (stdout: string): ReadonlyArray<PorcelainRef> =>
  stdout.split("\n").flatMap((line) => {
    const match = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (match === null) return [];
    const [, flag = "", refs = "", summary = ""] = match;
    const colon = refs.lastIndexOf(":");
    return [{ flag, to: colon < 0 ? refs : refs.slice(colon + 1), summary }];
  });

/** A rejected ref whose summary says origin has work the pushed commit lacks. */
const isDivergence = (summary: string) =>
  summary.startsWith("[rejected]") && /\((fetch first|non-fast-forward)\)/.test(summary);

/** Stderr of a push that never reached a ref status because the credential may not write. */
const DENIED =
  /Permission to \S+ denied|denied to \S+|returned error: 403|not allowed to push|write access to repository not granted/i;

/**
 * The lines of a failed push's stderr that say the credential may not write (GitHub's
 * "Permission to o/r.git denied to user."), `remote:` prefix removed. Empty for every other
 * failure, including an ssh key the host refused outright, which stays a transport failure.
 */
export const deniedLines = (stderr: string): ReadonlyArray<string> =>
  stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^remote:\s*/, "").trim())
    .filter((line) => DENIED.test(line));

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * Step 2: one commit for the work the agent left uncommitted. When the checkpoint's tree is the
 * parent's tree the agent's commits already hold everything and nothing is written; otherwise
 * `commit-tree` writes the checkpoint's tree on the parent, authored and committed by the owner.
 * Moving a ref is the caller's: the store moves the session branch, a runner packs the commit.
 */
export const writeLandingCommit = Effect.fn("writeLandingCommit")(function* (
  dir: string,
  input: LandingCommitInput,
) {
  const parent = yield* commitOf(dir, input.parent);
  const [parentTree, tree] = yield* Effect.all([
    treeOf(dir, parent),
    treeOf(dir, input.checkpoint),
  ]);
  if (parentTree === tree) return { head: parent, written: null } satisfies LandingCommit;
  const identity = {
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_COMMITTER_NAME: input.author.name,
    GIT_COMMITTER_EMAIL: input.author.email,
  };
  const sha = Sha.make(
    yield* git(
      ["commit-tree", tree, "-p", parent, "-F", "-"],
      dir,
      identity,
      undefined,
      input.message,
    ),
  );
  return { head: sha, written: { sha, tree, parent } } satisfies LandingCommit;
});

/**
 * Origin's branch against `sha`: `ls-remote` for its tip, a fetch of that branch when the tip is
 * not already here (no ref is written for it), then the commit counts both ways.
 */
export const probeRemoteBranch = Effect.fn("probeRemoteBranch")(function* (
  dir: string,
  input: ProbeInput,
) {
  const ref = yield* checkBranch(input.remoteBranch);
  const local = yield* commitOf(dir, input.sha);
  const listed = yield* git(["ls-remote", "--", input.remote, ref], dir, input.remoteEnv);
  const remoteSha =
    listed
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, name]) => name === ref)?.[0] ?? null;
  if (remoteSha === null) {
    return {
      remoteBranch: input.remoteBranch,
      remoteSha: null,
      unseen: 0,
      ahead: null,
      holds: false,
    } satisfies RemoteBranchState;
  }
  const present = yield* git(["cat-file", "-e", `${remoteSha}^{commit}`], dir).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (!present) {
    yield* git(
      ["fetch", "--no-tags", "--no-write-fetch-head", "--", input.remote, ref],
      dir,
      input.remoteEnv,
    );
  }
  const counts = yield* git(
    ["rev-list", "--count", "--left-right", `${local}...${remoteSha}`],
    dir,
  );
  const [ahead = "0", unseen = "0"] = counts.split("\t");
  return {
    remoteBranch: input.remoteBranch,
    remoteSha: Sha.make(remoteSha),
    unseen: Number(unseen),
    ahead: Number(ahead),
    holds: Number(ahead) === 0,
  } satisfies RemoteBranchState;
});

/**
 * Step 3: push `sha` to `refs/heads/<remoteBranch>` on the remote, fast-forward only: the refspec
 * carries no `+` and no force flag is ever passed, so origin itself refuses a push that would
 * drop its commits. A refusal comes back typed, in the remote's words; a transport failure stays
 * a `GitError` for the caller's readable line (`describeGitRemoteFailure`).
 */
export const pushBranch = Effect.fn("pushBranch")(function* (dir: string, input: PushInput) {
  const ref = yield* checkBranch(input.remoteBranch);
  const sha = yield* commitOf(dir, input.sha);
  const args = ["push", "--porcelain", "--", input.remote, `${sha}:${ref}`];
  const out = yield* gitOutput(args, dir, input.remoteEnv);
  const words = remoteWords(out.stderr);
  const status = parsePushPorcelain(out.stdout).find((line) => line.to === ref);
  if (status === undefined) {
    const denied = deniedLines(out.stderr);
    if (denied.length > 0) {
      return yield* new PushRefusedError({
        remoteBranch: input.remoteBranch,
        reason: "denied",
        message: denied.join("\n"),
        remoteSha: null,
        unseen: null,
      });
    }
    return yield* new GitError({
      args,
      cwd: dir,
      exitCode: out.exitCode,
      stderr: out.stderr.trim(),
    });
  }
  if (status.flag !== "!") {
    return {
      remoteBranch: input.remoteBranch,
      pushedSha: sha,
      created: status.flag === "*",
      upToDate: status.flag === "=",
    } satisfies Pushed;
  }
  const message = [...words, status.summary].join("\n");
  if (!isDivergence(status.summary)) {
    return yield* new PushRefusedError({
      remoteBranch: input.remoteBranch,
      reason: "rejected",
      message,
      remoteSha: null,
      unseen: null,
    });
  }
  // How far origin moved is worth a second round trip; not knowing it is not a failure.
  const state = yield* probeRemoteBranch(dir, {
    remote: input.remote,
    remoteBranch: input.remoteBranch,
    sha,
    remoteEnv: input.remoteEnv,
  }).pipe(Effect.option);
  return yield* new PushRefusedError({
    remoteBranch: input.remoteBranch,
    reason: "diverged",
    message,
    remoteSha: state._tag === "Some" ? state.value.remoteSha : null,
    unseen: state._tag === "Some" ? state.value.unseen : null,
  });
});

/**
 * A git bundle of `base..tip` naming `refs/heads/<branch>`, for `mend pull`. It is written in a
 * scratch repository that borrows `dir`'s objects (alternates) and holds the one branch ref, so
 * no ref is added to the store or the cache. Refused over `limitBytes` with the size.
 */
export const createChangeBundle = Effect.fn("createChangeBundle")(function* (
  dir: string,
  input: BundleInput,
) {
  const ref = yield* checkBranch(input.branch);
  const [base, tip] = yield* Effect.all([commitOf(dir, input.base), commitOf(dir, input.tip)]);
  const commits = Number(yield* git(["rev-list", "--count", `${base}..${tip}`], dir));
  if (commits === 0) {
    return yield* new BundleEmptyError({ branch: input.branch, base, tip });
  }
  const objects = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], dir);
  const scratch = yield* Effect.sync(() =>
    fs.mkdtempSync(path.join(os.tmpdir(), "mend-change-bundle-")),
  );
  const build = Effect.gen(function* () {
    yield* git(["init", "-q", "--bare", scratch], os.tmpdir());
    yield* Effect.sync(() =>
      fs.writeFileSync(path.join(scratch, "objects", "info", "alternates"), `${objects}\n`),
    );
    yield* git(["update-ref", ref, tip], scratch);
    const file = path.join(scratch, "change.bundle");
    yield* git(["bundle", "create", "-q", file, `${base}..${ref}`], scratch);
    const size = yield* Effect.sync(() => fs.statSync(file).size);
    if (size > input.limitBytes) {
      return yield* new BundleTooLargeError({
        branch: input.branch,
        size,
        limit: input.limitBytes,
      });
    }
    const bytes = yield* Effect.sync(() => new Uint8Array(fs.readFileSync(file)));
    return { branch: input.branch, base, tip, commits, bytes } satisfies ChangeBundle;
  });
  return yield* build.pipe(
    Effect.ensuring(Effect.sync(() => fs.rmSync(scratch, { recursive: true, force: true }))),
  );
});
