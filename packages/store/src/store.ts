import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Sha } from "@mend/domain";
import { RepositoryCloneUrl } from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { git, GitError } from "./git.ts";
import { mendHome } from "./paths.ts";

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

export class AdoptError extends Schema.TaggedErrorClass<AdoptError>()("AdoptError", {
  name: Schema.String,
  source: RepositoryCloneUrl,
  cause: GitError,
}) {}

/** Named to dodge the JS global `ReferenceError`; same shape as `AdoptError`. */
export class ReferenceCloneError extends Schema.TaggedErrorClass<ReferenceCloneError>()(
  "ReferenceCloneError",
  {
    name: Schema.String,
    source: Schema.String,
    cause: GitError,
  },
) {}

export interface ReferenceClone {
  /** Absolute path of the working clone: `<root>/_references/<name>`. */
  readonly path: string;
  readonly headSha: Sha;
}

export interface AdoptedRepo {
  /** Absolute path of the bare repo: `<root>/<name>/repo.git`. */
  readonly storePath: string;
  readonly defaultBranch: string;
  readonly headSha: Sha;
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

/** Git facts for one file in an immutable commit range. */
export interface DiffFileFact {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

interface NumstatEntry {
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
    if (raw[cursor] === "\0") {
      cursor += 1;
      cursor = raw.indexOf("\0", cursor) + 1;
      cursor = raw.indexOf("\0", cursor) + 1;
    } else {
      const terminator = raw.indexOf("\0", cursor);
      cursor = terminator < 0 ? raw.length : terminator + 1;
    }
    entries.push({
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
      ...counts,
    });
  }
  return files;
};

const sha = (value: string) => Sha.make(value);

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
  git(["ls-files", "--others", "--exclude-standard"], worktreePath).pipe(
    Effect.map((out) => (out === "" ? [] : out.split("\n"))),
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
     * from the git-auth seam — the store itself never decides credentials.
     */
    readonly adopt: (
      name: string,
      source: RepositoryCloneUrl,
      remoteEnv: Record<string, string>,
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
      remoteEnv: Record<string, string> | null,
    ) => Effect.Effect<SessionWorktree, GitError>;
    /**
     * The base a new worktree starts from, resolved the way `createWorktree` resolves it (the
     * default branch when null; origin freshened first when credentials are given) — for
     * adapters that create no directory here (the capture store).
     */
    readonly resolveBase: (
      storePath: string,
      base: string | null,
      remoteEnv: Record<string, string> | null,
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
      remoteEnv: Record<string, string> | null,
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
      remoteEnv: Record<string, string>,
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
      options?: {
        readonly ignoreWhitespace?: boolean;
        readonly contextLines?: number;
      },
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
    /** Every path in one commit's tree (`ls-tree -r`), for the bare store when no worktree is in play. */
    readonly listTreeFiles: (
      dir: string,
      ref: string,
      limit: number,
    ) => Effect.Effect<FileListing, GitError>;
    /**
     * Clone `source` shallow into `_references/<name>` as read-only source
     * material (plan §17, decided 2026-08-01). `ref` pins a branch or tag;
     * null follows the remote's default branch. A working clone, not bare —
     * the point is an agent reading files.
     */
    readonly cloneReference: (
      name: string,
      source: string,
      ref: string | null,
      remoteEnv: Record<string, string>,
    ) => Effect.Effect<ReferenceClone, ReferenceCloneError>;
    /** Re-fetch the pinned ref (or the clone's branch) shallow and hard-reset to it. */
    readonly refreshReference: (
      clonePath: string,
      ref: string | null,
      remoteEnv: Record<string, string>,
    ) => Effect.Effect<ReferenceClone, GitError>;
    /** Delete the clone directory. Selection rows are the caller's concern. */
    readonly removeReference: (clonePath: string) => Effect.Effect<void>;
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
        name: string,
        source: RepositoryCloneUrl,
        remoteEnv: Record<string, string>,
      ) {
        const projectDir = path.join(config.root, name);
        const storePath = path.join(projectDir, "repo.git");
        const attempt = Effect.gen(function* () {
          yield* Effect.sync(() => fs.mkdirSync(config.root, { recursive: true }));
          yield* git(["clone", "--bare", "--", source, storePath], config.root, remoteEnv);
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
          Effect.catch((cause) => Effect.fail(new AdoptError({ name, source, cause }))),
        );
      });

      /**
       * Freshen one base ref from the project origin before resolving it — best-effort by
       * contract: a session must start offline, on a disconnected bridge, or against a gone
       * remote, just on the base the store already has. `remoteEnv` null means the caller could
       * not resolve credentials (and said why); no fetch is attempted at all.
       */
      const freshenBase = Effect.fn("Store.freshenBase")(function* (
        storePath: string,
        baseRef: string,
        remoteEnv: Record<string, string> | null,
      ) {
        if (remoteEnv === null) return;
        yield* git(["fetch", "origin", baseRef], storePath, remoteEnv).pipe(
          Effect.tapError((error) =>
            Effect.logDebug("store: base freshen skipped").pipe(
              Effect.annotateLogs({ storePath, baseRef, stderr: error.stderr }),
            ),
          ),
          Effect.ignore,
        );
      });

      /**
       * Resolve a requested base to a commit, preferring what origin says over the store's own
       * head: local `refs/heads/*` freeze at adoption, while `refs/remotes/origin/*` move with
       * every fetch — so the remote-tracking name is the current answer and the local name is
       * the fallback (shas, tags, and never-pushed local branches). A base the store does not
       * know at all gets one authenticated fetch (a branch pushed but never fetched — adopt
       * configures the refspec for exactly this) before failing with something a person can act
       * on instead of raw stderr.
       */
      const resolveBaseSha = Effect.fn("Store.resolveBaseSha")(function* (
        storePath: string,
        baseRef: string,
        remoteEnv: Record<string, string> | null,
      ) {
        const tryResolve = (ref: string) => git(["rev-parse", `${ref}^{commit}`], storePath);
        return yield* tryResolve(`refs/remotes/origin/${baseRef}`).pipe(
          Effect.catch(() => tryResolve(baseRef)),
          Effect.catch(() =>
            git(["fetch", "origin"], storePath, remoteEnv ?? { GIT_TERMINAL_PROMPT: "0" }).pipe(
              Effect.ignore,
              Effect.andThen(
                tryResolve(baseRef).pipe(Effect.catch(() => tryResolve(`origin/${baseRef}`))),
              ),
              Effect.mapError(
                (cause) =>
                  new GitError({
                    args: ["rev-parse", `${baseRef}^{commit}`],
                    cwd: storePath,
                    exitCode: cause.exitCode,
                    stderr: `base "${baseRef}" is not a branch, tag, or commit this project's store knows (origin was fetched and it is still unknown) — push it to the project origin or start from another base`,
                  }),
              ),
            ),
          ),
        );
      });

      const createWorktree = Effect.fn("Store.createWorktree")(function* (
        storePath: string,
        identity: { readonly directory: string; readonly branch: string },
        base: string | null,
        remoteEnv: Record<string, string> | null,
      ) {
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
        remoteEnv: Record<string, string> | null,
      ) {
        const baseRef = base ?? (yield* git(["symbolic-ref", "--short", "HEAD"], storePath));
        yield* freshenBase(storePath, baseRef, remoteEnv);
        const baseSha = yield* resolveBaseSha(storePath, baseRef, remoteEnv);
        return { baseRef, baseSha: sha(baseSha) };
      });

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
        remoteEnv: Record<string, string> | null,
      ) {
        const worktreePath = path.join(path.dirname(storePath), "worktrees", name);
        const baseRef = base ?? (yield* git(["symbolic-ref", "--short", "HEAD"], storePath));
        yield* freshenBase(storePath, baseRef, remoteEnv);
        const baseSha = yield* resolveBaseSha(storePath, baseRef, remoteEnv);
        yield* git(["reset", "--hard", baseSha], worktreePath);
        yield* git(["clean", "-fd"], worktreePath);
        return { path: worktreePath, baseSha: sha(baseSha), baseRef };
      });

      const refreshFromOrigin = Effect.fn("Store.refreshFromOrigin")(function* (
        storePath: string,
        remoteEnv: Record<string, string>,
      ) {
        // Both refspecs in one fetch: heads for the store's own tree reads (files listing,
        // default-branch resolution), remote-tracking for base resolution. Forced — the store
        // holds no local work on origin's branches; sessions commit on `mend/session/*` only.
        yield* git(
          ["fetch", "origin", "+refs/heads/*:refs/heads/*", "+refs/heads/*:refs/remotes/origin/*"],
          storePath,
          remoteEnv,
        );
      });

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
        for (const line of local.split("\n")) {
          const parsed = branchLine(line);
          if (parsed === null) continue;
          if (parsed.name.startsWith("mend/session/")) continue;
          if (parsed.name.startsWith("mend/wt/")) continue;
          byName.set(parsed.name, parsed);
        }
        for (const line of remote.split("\n")) {
          const parsed = branchLine(line);
          if (parsed === null || parsed.name === "HEAD") continue;
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
        options?: {
          readonly ignoreWhitespace?: boolean;
          readonly contextLines?: number;
        },
      ) {
        const args = ["diff", "--find-renames"];
        if (options?.ignoreWhitespace === true) args.push("--ignore-all-space");
        if (options?.contextLines !== undefined) args.push(`--unified=${options.contextLines}`);
        args.push(a, b);
        return yield* git(args, dir);
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
        const args = b === null ? ["diff", "--numstat", a] : ["diff", "--numstat", a, b];
        const out = yield* git(args, dir);
        const tracked =
          out === ""
            ? []
            : out.split("\n").map((line) => {
                const [additions = "0", deletions = "0", ...rest] = line.split("\t");
                return {
                  path: rest.join("\t"),
                  additions: additions === "-" ? 0 : Number(additions),
                  deletions: deletions === "-" ? 0 : Number(deletions),
                };
              });
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

      const listTreeFiles = Effect.fn("Store.listTreeFiles")(function* (
        dir: string,
        ref: string,
        limit: number,
      ) {
        const out = yield* git(["ls-tree", "-r", "-z", "--name-only", ref], dir);
        return capListing(out.split("\0"), limit);
      });

      const headSha = Effect.fn("Store.headSha")(function* (dir: string) {
        const head = yield* git(["rev-parse", "HEAD"], dir);
        return sha(head);
      });

      // `_references/` cannot collide with a project dir: adopted names go
      // through the API's name check, which rejects a leading underscore.
      const cloneReference = Effect.fn("Store.cloneReference")(function* (
        name: string,
        source: string,
        ref: string | null,
        remoteEnv: Record<string, string>,
      ) {
        const referencesRoot = path.join(config.root, "_references");
        const clonePath = path.join(referencesRoot, name);
        const attempt = Effect.gen(function* () {
          yield* Effect.sync(() => fs.mkdirSync(referencesRoot, { recursive: true }));
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
            remoteEnv,
          );
          const head = yield* git(["rev-parse", "HEAD"], clonePath);
          return { path: clonePath, headSha: sha(head) };
        });
        return yield* attempt.pipe(
          Effect.catch((cause) => Effect.fail(new ReferenceCloneError({ name, source, cause }))),
        );
      });

      const refreshReference = Effect.fn("Store.refreshReference")(function* (
        clonePath: string,
        ref: string | null,
        remoteEnv: Record<string, string>,
      ) {
        // No pin = follow whatever branch the clone is on. FETCH_HEAD + hard
        // reset handles branches and tags uniformly, force-pushes included —
        // a reference clone has no local work to protect.
        const target = ref ?? (yield* git(["symbolic-ref", "--short", "HEAD"], clonePath));
        yield* git(["fetch", "--depth", "1", "origin", target], clonePath, remoteEnv);
        yield* git(["reset", "--hard", "FETCH_HEAD"], clonePath);
        const head = yield* git(["rev-parse", "HEAD"], clonePath);
        return { path: clonePath, headSha: sha(head) };
      });

      const removeReference = Effect.fn("Store.removeReference")(function* (clonePath: string) {
        yield* Effect.sync(() => fs.rmSync(clonePath, { recursive: true, force: true }));
      });

      return {
        cloneReference,
        refreshReference,
        removeReference,
        adopt,
        createWorktree,
        resolveBase,
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
        headSha,
        listWorktreeFiles,
        listTreeFiles,
      };
    }),
  );
}
