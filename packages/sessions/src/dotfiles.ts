import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DotfilesRepository } from "@mend/domain";
import { Duration, Effect, Schema } from "effect";

/**
 * Launch-side dotfiles resolution. The platform applies dotfiles from archives the caller ships
 * with the create call, so nothing sensitive reaches the container — only file trees. Two
 * sources, in apply order:
 *
 * 1. the user's dotfiles REPOSITORY — cloned by the Mend server at launch, so every session gets
 *    the branch tip as of that moment;
 * 2. the user's dotfiles STORE snapshot — home files synced from wherever the user actually
 *    works, packed by the store as an exact, sha-named commit. Applied second, so the explicit
 *    selection wins over same-named repo files.
 *
 * The server's own home directory is deliberately never read (see @mend/store DotfilesStore).
 */

/** Resolving the user's dotfiles failed; the message is readable, the launch fails loudly. */
export class DotfilesResolveError extends Schema.TaggedErrorClass<DotfilesResolveError>()(
  "DotfilesResolveError",
  { message: Schema.String },
) {}

/** The platform caps one archive at ~4MB decoded; anything larger is a packaging mistake. */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

/**
 * Bounds on the server-side clone. A tenant chooses the URL, and the clone runs at every launch
 * in the Mend server itself, so time, disk and memory are all bounded before git starts.
 */
export interface DotfilesCloneBounds {
  /** Wall clock for clone plus pack; past it every git process of the clone is killed. */
  readonly timeoutMs: number;
  /** Files above this are never downloaded (a partial clone); a tree that needs one is refused. */
  readonly maxFileBytes: number;
  /** The clone on disk, watched while git runs; past it the clone is killed. */
  readonly maxCloneBytes: number;
  /** The packed archive: the platform's cap on one dotfiles archive. */
  readonly maxArchiveBytes: number;
}

export const DOTFILES_CLONE_BOUNDS: DotfilesCloneBounds = {
  timeoutMs: 60_000,
  maxFileBytes: MAX_ARCHIVE_BYTES,
  maxCloneBytes: 64 * 1024 * 1024,
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
};

/** How often the clone's size on disk is measured while git runs. */
const CLONE_SIZE_POLL = Duration.millis(200);

/** What the launch hands the SDK: gzipped tars in apply order. */
export interface ResolvedDotfilesArchive {
  readonly data: string;
  readonly manager: "auto" | "chezmoi" | "stow" | "copy";
  readonly bootstrap: boolean;
}

/**
 * The clone's git environment. A daemon cannot answer a prompt, so neither git nor ssh may ask:
 * auth failures surface as readable errors instead of hangs. `pin` (the source policy's
 * `pinnedEnv`) composes over these defaults, so a pinned ssh command keeps `BatchMode=yes`.
 */
export const dotfilesCloneEnv = (
  pin: (env: Readonly<Record<string, string>>) => Record<string, string> = (env) => ({ ...env }),
): Record<string, string> =>
  pin({ GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });

/**
 * The environment of every git command after the clone: none of them may reach the network. A
 * blob the filter left out would otherwise be fetched lazily, unbounded and without the clone's
 * pinned address, by the first command that reads it (git 2.39, the Mend image's, fetches it for
 * `cat-file -t`). git 2.45+ honours `GIT_NO_LAZY_FETCH`; `protocol.allow=never` refuses every
 * transport on older git too.
 */
export const DOTFILES_LOCAL_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.allow",
  GIT_CONFIG_VALUE_0: "never",
};

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Number((bytes / (1024 * 1024)).toFixed(1))}MB`
    : `${Math.ceil(bytes / 1024)}KB`;

interface GitFailure {
  readonly stderr: string;
  /** stdout passed `maxBuffer`; git was killed. */
  readonly overflow: boolean;
}

/** Kill git and every helper it started; the group is gone already when git exited on its own. */
const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

/**
 * git in its own process group, so an interrupt (the deadline, the size watch) kills git and
 * every helper it started (remote-https, ssh, index-pack) instead of leaving them on the socket.
 * stdout is held to `maxBuffer`: past it the group is killed and the failure says so.
 */
const runGit = (
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly maxBuffer?: number;
  },
  describe: (failure: GitFailure) => string,
): Effect.Effect<Buffer, DotfilesResolveError> =>
  Effect.callback((resume) => {
    const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let overflow = false;
    let settled = false;
    const settle = (result: Effect.Effect<Buffer, DotfilesResolveError>) => {
      if (settled) return;
      settled = true;
      resume(result);
    };
    const fail = (message: string) =>
      settle(
        Effect.fail(new DotfilesResolveError({ message: describe({ stderr: message, overflow }) })),
      );
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBuffer) {
        overflow = true;
        killGroup(child.pid);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // git's own message is short; a remote that floods stderr is not held in memory.
      if (stderr.length < 256) stderr.push(chunk);
    });
    child.on("error", (error) => fail(error.message));
    child.on("close", (code, signal) => {
      if (code === 0 && !overflow) {
        settle(Effect.succeed(Buffer.concat(stdout)));
        return;
      }
      fail(
        Buffer.concat(stderr).toString("utf8").trim() ||
          `git ${args[0] ?? ""} exited ${code ?? signal ?? "abnormally"}`,
      );
    });
    return Effect.sync(() => killGroup(child.pid));
  });

/** Bytes under `dir`; entries that vanish mid-walk (git's temporary packs) count as nothing. */
const directoryBytes = (dir: string): number => {
  let total = 0;
  let entries: ReadonlyArray<fs.Dirent> = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(entryPath);
      continue;
    }
    try {
      total += fs.lstatSync(entryPath).size;
    } catch {
      // Renamed or removed while git ran.
    }
  }
  return total;
};

/**
 * Shallow, partial clone of the dotfiles repo and a pack of the checkout via `git archive`
 * (tracked files only, `.git` never included). Bounded before git starts: one branch, depth 1,
 * no tags, no files above `maxFileBytes` downloaded at all, the clone's disk use watched while it
 * runs, the archive capped as it streams, and one deadline over the whole of it.
 */
const buildRepositoryArchive = (
  repository: DotfilesRepository,
  cloneEnv: Readonly<Record<string, string>>,
  bounds: DotfilesCloneBounds,
): Effect.Effect<ResolvedDotfilesArchive, DotfilesResolveError> =>
  Effect.gen(function* () {
    const checkout = yield* Effect.sync(() =>
      fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotfiles-")),
    );
    const cleanup = Effect.sync(() => {
      fs.rmSync(checkout, { recursive: true, force: true });
    });
    const label = `the dotfiles repo ${repository.url}`;
    const cloneTooLarge = new DotfilesResolveError({
      message: `${label} was stopped at more than ${formatBytes(bounds.maxCloneBytes)} cloned — Mend clones at most ${formatBytes(bounds.maxCloneBytes)} of a dotfiles repository (one branch, depth 1).`,
    });
    const watchCloneSize = Effect.sync(() => directoryBytes(checkout)).pipe(
      Effect.flatMap((bytes) =>
        bytes > bounds.maxCloneBytes ? Effect.fail(cloneTooLarge) : Effect.void,
      ),
      Effect.andThen(Effect.sleep(CLONE_SIZE_POLL)),
      Effect.forever,
    );
    // Nothing after the clone may reach the network: a blob the filter left out is refused
    // below, never fetched.
    const localEnv = DOTFILES_LOCAL_GIT_ENV;
    const pack = Effect.gen(function* () {
      yield* Effect.raceFirst(
        runGit(
          [
            "clone",
            "--no-checkout",
            "--depth",
            "1",
            "--single-branch",
            "--no-tags",
            `--filter=blob:limit=${bounds.maxFileBytes}`,
            ...(repository.ref === null ? [] : ["--branch", repository.ref]),
            repository.url,
            checkout,
          ],
          { cwd: os.tmpdir(), env: cloneEnv },
          ({ stderr }) => `dotfiles clone of ${repository.url} failed: ${stderr}`,
        ),
        watchCloneSize,
      );
      // A clone that finished between two measurements is measured once more.
      if ((yield* Effect.sync(() => directoryBytes(checkout))) > bounds.maxCloneBytes) {
        return yield* cloneTooLarge;
      }
      // `HEAD:<subdirectory>` re-roots the archive: the subtree's CONTENTS land at ~, so a repo
      // whose home mirror lives in a subfolder (`dots/`) applies without restructuring.
      const treeish = repository.subdirectory === null ? "HEAD" : `HEAD:${repository.subdirectory}`;
      const kind = yield* runGit(
        ["cat-file", "-t", treeish],
        { cwd: checkout, env: localEnv },
        () => "missing",
      ).pipe(
        Effect.map((out) => out.toString("utf8").trim()),
        Effect.orElseSucceed(() => "missing"),
      );
      if (kind !== "tree" && kind !== "commit") {
        return yield* new DotfilesResolveError({
          message: `${label} has ${repository.subdirectory === null ? "no commit" : `no directory ${repository.subdirectory}`} at ${repository.ref ?? "its default branch"}.`,
        });
      }
      // Blobs the filter left out are listed with a leading `?`; name them by path.
      const listed = (yield* runGit(
        ["rev-list", "--objects", "--missing=print", treeish],
        { cwd: checkout, env: localEnv },
        ({ stderr }) => `${label} could not be read: ${stderr}`,
      )).toString("utf8");
      const missing = new Set(
        listed
          .split("\n")
          .filter((line) => line.startsWith("?"))
          .map((line) => line.slice(1).trim()),
      );
      if (missing.size > 0) {
        const tree = (yield* runGit(
          ["ls-tree", "-r", "-z", treeish],
          { cwd: checkout, env: localEnv },
          ({ stderr }) => `${label} could not be read: ${stderr}`,
        )).toString("utf8");
        const prefix = repository.subdirectory === null ? "" : `${repository.subdirectory}/`;
        const paths = tree.split("\0").flatMap((line) => {
          const [meta = "", filePath = ""] = line.split("\t");
          const sha = meta.split(" ")[2];
          return sha !== undefined && missing.has(sha) ? [`${prefix}${filePath}`] : [];
        });
        return yield* new DotfilesResolveError({
          message: `${label} has files larger than ${formatBytes(bounds.maxFileBytes)}, which Mend does not download: ${paths.join(", ")}. Dotfiles are text; move these out of the applied tree.`,
        });
      }
      const archive = yield* runGit(
        ["archive", "--format=tar.gz", treeish],
        { cwd: checkout, env: localEnv, maxBuffer: bounds.maxArchiveBytes },
        ({ stderr, overflow }) =>
          overflow
            ? `${label} packs to more than ${formatBytes(bounds.maxArchiveBytes)} — the platform caps one dotfiles archive at ${formatBytes(bounds.maxArchiveBytes)}. Trim it (dotfiles are text).`
            : `git archive of ${label} failed: ${stderr}`,
      );
      return {
        data: archive.toString("base64"),
        manager: repository.manager,
        bootstrap: repository.bootstrap,
      };
    });
    return yield* pack.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(bounds.timeoutMs),
        orElse: () =>
          Effect.fail(
            new DotfilesResolveError({
              message: `${label} was stopped after ${bounds.timeoutMs / 1000}s — Mend gives a dotfiles repository ${bounds.timeoutMs / 1000}s to clone and pack.`,
            }),
          ),
      }),
      Effect.ensuring(cleanup),
    );
  });

/**
 * Resolve the owner's dotfiles into launch archives: the repository first, the store snapshot
 * after (in-order apply means the synced selection wins). The snapshot is already a packed
 * `.tar.gz` from the dotfiles store; it applies with the copy manager and never a bootstrap.
 * Nothing configured resolves to no archives.
 */
export const resolveDotfilesArchives = (input: {
  readonly repository: DotfilesRepository | null;
  readonly snapshot: { readonly sha: string; readonly data: string } | null;
  /** Pins the clone to the address the source policy checked; composes over the defaults. */
  readonly pinCloneEnv?: (env: Readonly<Record<string, string>>) => Record<string, string>;
  /** Tests shrink these; production uses {@link DOTFILES_CLONE_BOUNDS}. */
  readonly bounds?: DotfilesCloneBounds;
}): Effect.Effect<ReadonlyArray<ResolvedDotfilesArchive>, DotfilesResolveError> =>
  Effect.gen(function* () {
    const archives: ResolvedDotfilesArchive[] = [];
    if (input.repository !== null) {
      archives.push(
        yield* buildRepositoryArchive(
          input.repository,
          dotfilesCloneEnv(input.pinCloneEnv),
          input.bounds ?? DOTFILES_CLONE_BOUNDS,
        ),
      );
    }
    if (input.snapshot !== null) {
      archives.push({ data: input.snapshot.data, manager: "copy", bootstrap: false });
    }
    return archives;
  });
