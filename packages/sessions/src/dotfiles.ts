import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type GitAccessMode, InstanceRolesRepo, UserGitAccessRepo } from "@mend/db";
import type { DotfilesRepository } from "@mend/domain";
import { gitRemoteLocation, TenancyMode } from "@mend/domain/workbench";
import { AgentBridge, describeGitRemoteFailure, MendKeys, resolveRemoteEnv } from "@mend/store";
import { Config, Duration, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * Launch-side dotfiles resolution. The platform applies dotfiles from archives the caller ships
 * with the create call, so nothing sensitive reaches the container — only file trees. Two
 * sources, in apply order, each resolved on its own (one failing never takes the other along):
 *
 * 1. the user's dotfiles REPOSITORY — cloned by the Mend server at launch, as its owner (never
 *    with the host's identity, except for the operator of a single-tenant install), so every
 *    session gets the branch tip as of that moment;
 * 2. the user's dotfiles STORE snapshot — home files synced from wherever the user actually
 *    works, packed by the store as an exact, sha-named commit. Applied second, so the explicit
 *    selection wins over same-named repo files.
 *
 * The server's own home directory is deliberately never read (see @mend/store DotfilesStore).
 */

/**
 * Resolving one dotfiles source failed; the message is readable. A launch goes on without that
 * source and records the message on the session; saving a repository refuses with it.
 */
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
 * Whose credential a dotfiles clone uses (docs/GIT-ACCESS.md, "Dotfiles"):
 *
 * - `host`: this machine's own git and ssh setup, as a shell here would clone. Only for the
 *   operator of a single-tenant install, the one account the host's setup belongs to (the same
 *   rule as the host's `gh` login for GitHub API calls).
 * - `owner-ssh`: an ssh URL, signed with the owner's git access: their Mend key, or their
 *   connected signer when their git access is the bridge.
 * - `none`: an HTTPS (or git://) URL for anyone else. Mend holds no HTTPS credential of theirs
 *   (a connected GitHub account's token lives in Sealant, which never returns it), so only a
 *   public repository clones that way.
 *
 * Every kind but `host` clones with nothing of the host's: see {@link DOTFILES_OWNER_ENV}.
 */
export type DotfilesCloneIdentity =
  | { readonly kind: "host" }
  | { readonly kind: "owner-ssh"; readonly mode: GitAccessMode }
  | { readonly kind: "none" };

export const dotfilesCloneIdentity = (input: {
  readonly url: string;
  readonly tenancy: TenancyMode;
  /** Whether the owner holds the instance's operator role. */
  readonly ownerIsOperator: boolean;
  /** The owner's git access choice; null (never chose) is the Mend key. */
  readonly ownerGitAccess: GitAccessMode | null;
}): DotfilesCloneIdentity => {
  if (input.tenancy === "single" && input.ownerIsOperator) return { kind: "host" };
  if (gitRemoteLocation(input.url)?.scheme === "ssh") {
    return { kind: "owner-ssh", mode: input.ownerGitAccess ?? "mend-key" };
  }
  return { kind: "none" };
};

/** The identity and the git environment a clone runs with, before the source policy's pin. */
export interface DotfilesCloneAccess {
  readonly identity: DotfilesCloneIdentity;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The host kind's git environment. A daemon cannot answer a prompt, so neither git nor ssh may
 * ask: auth failures surface as readable errors instead of hangs.
 */
export const DOTFILES_HOST_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

/**
 * Every other kind's base: nothing of the host's git or ssh setup reaches the clone. No system
 * or global git config (credential helpers, `insteadOf` rewrites, extra headers), none injected
 * through the environment, no askpass program, no ssh agent, no ssh config, whose
 * `IdentityFile` entries would otherwise be offered beside the owner's key, and none of ssh's
 * default key files (`IdentityFile=none`): ssh finds `~/.ssh/id_*` through the passwd entry, not
 * HOME, and offers them whenever no `-i` names a key, as on the bridge. The clone also runs
 * with HOME set to an empty directory made for it, so curl finds no `.netrc`.
 */
export const DOTFILES_OWNER_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_PARAMETERS: "",
  SSH_AUTH_SOCK: "",
  GIT_SSH_COMMAND: "ssh -F /dev/null -o IdentityFile=none -o BatchMode=yes",
};

/** The host kind; `resolveRepositoryArchive` clones with it unless given another access. */
export const HOST_DOTFILES_ACCESS: DotfilesCloneAccess = {
  identity: { kind: "host" },
  env: DOTFILES_HOST_ENV,
};

/**
 * The clone's git environment: `access` (the host kind unless given), then `pin` (the source
 * policy's `pinnedEnv`) composed over it, so a pinned ssh command keeps `BatchMode=yes` and the
 * owner's key.
 */
export const dotfilesCloneEnv = (
  pin: (env: Readonly<Record<string, string>>) => Record<string, string> = (env) => ({ ...env }),
  access: DotfilesCloneAccess = HOST_DOTFILES_ACCESS,
): Record<string, string> => pin(access.env);

/** Refused HTTPS credentials, as git reports them with prompts off. */
const HTTPS_AUTH_FAILURE =
  /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed|Repository not found|returned error: 40[13]/i;

/**
 * git's reason a clone failed, in the terms of the identity it ran as: the owner's refused key
 * says which key to add where, and a refused HTTPS clone says why Mend had no credential.
 */
const describeCloneFailure = (
  identity: DotfilesCloneIdentity,
  url: string,
  stderr: string,
): string => {
  if (identity.kind === "owner-ssh") {
    return describeGitRemoteFailure(stderr, identity.mode) ?? stderr;
  }
  const scheme = gitRemoteLocation(url)?.scheme;
  if (identity.kind === "none" && (scheme === "https" || scheme === "http")) {
    const line = stderr
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => HTTPS_AUTH_FAILURE.test(candidate));
    if (line !== undefined) {
      return `Mend clones your HTTPS dotfiles repository without a credential, so only a public one clones. For a private repository, save its SSH URL (git@host:owner/repo.git): Mend clones that as you, with your Mend key or your connected signer. (observed: ${line})`;
    }
  }
  return stderr;
};

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
  identity: DotfilesCloneIdentity,
  cloneEnv: Readonly<Record<string, string>>,
  bounds: DotfilesCloneBounds,
): Effect.Effect<ResolvedDotfilesArchive, DotfilesResolveError> =>
  Effect.gen(function* () {
    const checkout = yield* Effect.sync(() =>
      fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotfiles-")),
    );
    // An owner's clone gets an empty HOME of its own: nothing the host keeps there (`.netrc`,
    // git's global config) can lend the clone the host's credentials.
    const home =
      identity.kind === "host"
        ? null
        : yield* Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotfiles-home-")));
    const cloneEnvironment = home === null ? cloneEnv : { ...cloneEnv, HOME: home };
    const cleanup = Effect.sync(() => {
      fs.rmSync(checkout, { recursive: true, force: true });
      if (home !== null) fs.rmSync(home, { recursive: true, force: true });
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
            // No "Cloning into <server tmp dir>" line: stderr becomes the reason a user reads.
            "--quiet",
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
          { cwd: os.tmpdir(), env: cloneEnvironment },
          ({ stderr }) =>
            `dotfiles clone of ${repository.url} failed: ${describeCloneFailure(identity, repository.url, stderr)}`,
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
 * A dotfiles REPOSITORY as a launch archive: the bounded clone and pack above, as `access` (the
 * host kind unless given; the owner's comes from {@link DotfilesCloner}), with the source
 * policy's pin composed over its environment. The launch and the save-time probe both come
 * through {@link DotfilesCloner}, so a repository that saved is one this exact path packed, with
 * the same bounds and the same credentials.
 */
export const resolveRepositoryArchive = (
  repository: DotfilesRepository,
  options: {
    /** Whose credentials the clone uses and its git environment. */
    readonly access?: DotfilesCloneAccess;
    /** Pins the clone to the address the source policy checked; composes over the access env. */
    readonly pinCloneEnv?: (env: Readonly<Record<string, string>>) => Record<string, string>;
    /** Tests shrink these; production uses {@link DOTFILES_CLONE_BOUNDS}. */
    readonly bounds?: DotfilesCloneBounds;
  } = {},
): Effect.Effect<ResolvedDotfilesArchive, DotfilesResolveError> => {
  const access = options.access ?? HOST_DOTFILES_ACCESS;
  return buildRepositoryArchive(
    repository,
    access.identity,
    dotfilesCloneEnv(options.pinCloneEnv, access),
    options.bounds ?? DOTFILES_CLONE_BOUNDS,
  );
};

/**
 * The owner's clone access for `url` under the rule of {@link dotfilesCloneIdentity}, with their
 * signer resolved through the one seam every host-side remote op uses (`resolveRemoteEnv`). A
 * bridge with nobody sharing, or a key that cannot be made, fails readable; it never falls back
 * to the host's identity or anyone else's.
 */
export const dotfilesCloneAccess = (
  identity: DotfilesCloneIdentity,
  ownerUserId: string,
): Effect.Effect<DotfilesCloneAccess, DotfilesResolveError, MendKeys | AgentBridge> =>
  Effect.gen(function* () {
    if (identity.kind === "host") return HOST_DOTFILES_ACCESS;
    if (identity.kind === "none") return { identity, env: DOTFILES_OWNER_ENV };
    const signer = yield* resolveRemoteEnv(identity.mode, ownerUserId).pipe(
      Effect.catchTag(
        "NoSignerError",
        (error) =>
          new DotfilesResolveError({
            message: `the dotfiles repository signs with your connected signer: ${error.message}`,
          }),
      ),
      Effect.catchTag(
        "KeygenError",
        (error) =>
          new DotfilesResolveError({
            message: `the dotfiles repository signs with your Mend key, which could not be created: ${error.stderr}`,
          }),
      ),
    );
    return {
      identity,
      env: {
        ...DOTFILES_OWNER_ENV,
        ...signer,
        // No ssh config and no default key files: either would offer the host's keys beside the
        // owner's (see DOTFILES_OWNER_ENV).
        GIT_SSH_COMMAND: `${signer["GIT_SSH_COMMAND"] ?? "ssh -o BatchMode=yes"} -F /dev/null -o IdentityFile=none`,
      },
    };
  });

/**
 * Clones an owner's dotfiles repository as that owner (docs/GIT-ACCESS.md, "Dotfiles"): the
 * launch and the save-time probe both clone through it, so they use the same credentials.
 */
export class DotfilesCloner extends Context.Service<
  DotfilesCloner,
  {
    readonly archive: (
      ownerUserId: string,
      repository: DotfilesRepository,
      options?: {
        /** The source policy's pin for the address it checked. */
        readonly pinCloneEnv?: (env: Readonly<Record<string, string>>) => Record<string, string>;
      },
    ) => Effect.Effect<ResolvedDotfilesArchive, DotfilesResolveError>;
  }
>()("@mend/sessions/DotfilesCloner") {}

/** The cloner under a given tenancy; {@link DotfilesClonerLive} reads it from `MEND_TENANCY`. */
export const makeDotfilesClonerLayer = (
  tenancy: TenancyMode,
): Layer.Layer<
  DotfilesCloner,
  never,
  MendKeys | AgentBridge | UserGitAccessRepo | InstanceRolesRepo
> =>
  Layer.effect(
    DotfilesCloner,
    Effect.gen(function* () {
      const keys = yield* MendKeys;
      const bridge = yield* AgentBridge;
      const gitAccess = yield* UserGitAccessRepo;
      const roles = yield* InstanceRolesRepo;
      const archive = Effect.fn("DotfilesCloner.archive")(function* (
        ownerUserId: string,
        repository: DotfilesRepository,
        options: {
          readonly pinCloneEnv?: (env: Readonly<Record<string, string>>) => Record<string, string>;
        } = {},
      ) {
        const identity = dotfilesCloneIdentity({
          url: repository.url,
          tenancy,
          // Only single tenancy has a host identity to lend, so only it asks for the role.
          ownerIsOperator: tenancy === "single" && (yield* roles.isOperator(ownerUserId)),
          ownerGitAccess: yield* gitAccess.mode(ownerUserId),
        });
        const access = yield* dotfilesCloneAccess(identity, ownerUserId).pipe(
          Effect.provideService(MendKeys, keys),
          Effect.provideService(AgentBridge, bridge),
        );
        const clone = resolveRepositoryArchive(repository, {
          access,
          ...(options.pinCloneEnv === undefined ? {} : { pinCloneEnv: options.pinCloneEnv }),
        });
        if (identity.kind !== "owner-ssh" || identity.mode !== "bridge") return yield* clone;
        // The share client says what asked for the signature.
        const end = yield* bridge.begin(ownerUserId, `dotfiles clone → ${repository.url}`);
        return yield* clone.pipe(Effect.ensuring(Effect.sync(() => end())));
      });
      return { archive };
    }),
  );

export const DotfilesClonerLive: Layer.Layer<
  DotfilesCloner,
  Config.ConfigError,
  MendKeys | AgentBridge | UserGitAccessRepo | InstanceRolesRepo
> = Layer.unwrap(
  Effect.gen(function* () {
    // The same variable the tenancy gate reads; that gate refuses to start a mode it may not run.
    const tenancy = yield* Config.schema(TenancyMode, "MEND_TENANCY").pipe(
      Config.withDefault("single"),
    );
    return makeDotfilesClonerLayer(tenancy);
  }),
);

/**
 * The dotfiles STORE snapshot as a launch archive. It is already a packed `.tar.gz` from the
 * store; it applies with the copy manager and never a bootstrap, AFTER the repository archive,
 * so the synced selection wins over same-named repo files.
 */
export const snapshotArchive = (snapshot: { readonly data: string }): ResolvedDotfilesArchive => ({
  data: snapshot.data,
  manager: "copy",
  bootstrap: false,
});
