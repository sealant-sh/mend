import { execFile, spawn } from "node:child_process";

import { Effect, Schema } from "effect";

/** A git invocation that exited nonzero (or could not run at all). */
export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  stderr: Schema.String,
  /** The signal that ended git, when one did: the OOM killer's `SIGKILL`, a shutdown's `SIGTERM`. */
  signal: Schema.optionalKey(Schema.String),
  /**
   * Node's code when git's run failed outside git itself: `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
   * (git printed more than the buffer holds and was killed), `ENOENT`, `EAGAIN`, `EMFILE`…
   */
  code: Schema.optionalKey(Schema.String),
}) {}

interface ExecFailure {
  readonly code?: number | string | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

/** What ended a git run besides its exit code: the signal, Node's own code. */
const endedBy = (failure: ExecFailure) => ({
  ...(typeof failure.signal === "string" ? { signal: failure.signal } : {}),
  ...(typeof failure.code === "string" ? { code: failure.code } : {}),
});

/**
 * Words in git's stderr that name the Mend host's resources — its disk, memory, descriptors,
 * permissions, a file it could not open — rather than anything a repository holds. They win over
 * `GIT_CONTENT_REJECTION`: `could not read …: Input/output error` is the disk.
 */
const HOST_RESOURCE =
  /no space left on device|disk quota exceeded|file too large|too many open files|cannot allocate memory|out of memory|resource temporarily unavailable|read-only file system|input\/output error|permission denied|unable to create temporary file|mmap failed|cannot open existing pack|unable to write|short write|interrupted system call|bus error/i;

/**
 * What `git index-pack --verify` says of a pack whose bytes it rejects, and `git rev-list
 * --objects --missing=error` of a closure missing an object (collected from git 2.52–2.55: a
 * flipped byte, a truncated pack, a bad trailer, junk after it, a wrong signature, an index of
 * another pack, an object a tip needs that no pack holds).
 */
const GIT_CONTENT_REJECTION =
  /pack has bad object|inflate returned|serious inflate inconsistency|pack is corrupted|pack has junk|pack signature mismatch|pack version \d+ unsupported|unresolved delta|early EOF|premature end of pack|file '[^']*' validation error|does not match index|non-monotonic index|index file .* is too small|bad index version|delta base offset|unknown object type|collision found|fsck error|missing (?:blob|tree|commit|tag) object|bad (?:blob |tree |commit |tag )?object|invalid (?:blob|tree|commit|tag) object|expected type|not all child objects/i;

/**
 * Whether a failed git run said something about the content it read — a pack's bytes, a
 * closure's objects — rather than that the Mend host could not finish it (review 2026-09-28 (13)
 * #1). Only an exit git chose, with words `GIT_CONTENT_REJECTION` knows and none naming a host
 * resource, is about content. A signal (the OOM killer), Node's own failure (the output buffer,
 * the spawn), a full disk, a descriptor limit — or words not known here — say nothing about the
 * content: a check that ended so concluded nothing.
 */
export const gitRejectsContent = (error: GitError): boolean =>
  error.exitCode !== null &&
  error.signal === undefined &&
  error.code === undefined &&
  !HOST_RESOURCE.test(error.stderr) &&
  GIT_CONTENT_REJECTION.test(error.stderr);

/** The pinned identity every store git call starts from; `env` overrides it (a landing's owner). */
const gitProcessEnv = (env: Record<string, string> | undefined): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "mend",
  GIT_AUTHOR_EMAIL: "mend@localhost",
  GIT_COMMITTER_NAME: "mend",
  GIT_COMMITTER_EMAIL: "mend@localhost",
  ...env,
});

/**
 * Run git with args in cwd; resolve with trimmed stdout. Identity is pinned so
 * checkpoint commits never depend on the machine's git config. Deliberately
 * `node:child_process` — the store must not grow platform dependencies.
 * `okExitCodes` treats listed nonzero exits as success (`git diff --no-index`
 * exits 1 when the files differ — that IS the result, not a failure).
 */
export const git = (
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Record<string, string>,
  okExitCodes?: ReadonlyArray<number>,
  /** Bytes written to git's stdin, then closed (`pack-objects` reads its object list there). */
  stdin?: string,
): Effect.Effect<string, GitError> =>
  Effect.callback<string, GitError>((resume) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, env: gitProcessEnv(env) },
      (error, stdout) => {
        if (error === null) {
          resume(Effect.succeed(stdout.replace(/\n$/, "")));
          return;
        }
        const failure = error as ExecFailure;
        const exitCode = typeof failure.code === "number" ? failure.code : null;
        if (exitCode !== null && okExitCodes !== undefined && okExitCodes.includes(exitCode)) {
          // The callback's stdout, not error.stdout — execFile only attaches
          // output to the error in its promisified form.
          resume(Effect.succeed(stdout.replace(/\n$/, "")));
          return;
        }
        resume(
          Effect.fail(
            new GitError({
              args: [...args],
              cwd,
              exitCode,
              stderr: (failure.stderr ?? failure.message ?? "").trim(),
              ...endedBy(failure),
            }),
          ),
        );
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    return Effect.sync(() => child.kill());
  });

/**
 * Run git with args in cwd; resolve with stdout as bytes, untouched — for output that names paths
 * (`ls-tree -z`), which are bytes and need not be UTF-8.
 */
export const gitBytes = (
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<Buffer, GitError> =>
  Effect.callback<Buffer, GitError>((resume) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, env: gitProcessEnv(undefined), encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed(stdout));
          return;
        }
        resume(
          Effect.fail(
            new GitError({
              args: [...args],
              cwd,
              exitCode: typeof error.code === "number" ? error.code : null,
              stderr: (stderr.length > 0 ? stderr.toString("utf8") : error.message).trim(),
              ...endedBy(error),
            }),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

/** What one git call printed and how it exited, whatever the exit code. */
export interface GitOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run git and keep both streams and the exit code, failing only when git could not run at all.
 * For the calls whose answer is on both streams even when git exits nonzero: `push --porcelain`
 * prints each ref's status on stdout and the remote's own words (`remote: …`) on stderr.
 */
export const gitOutput = (
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Record<string, string>,
): Effect.Effect<GitOutput, GitError> =>
  Effect.callback<GitOutput, GitError>((resume) => {
    const child = execFile(
      "git",
      [...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, env: gitProcessEnv(env) },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed({ exitCode: 0, stdout, stderr }));
          return;
        }
        const failure = error as ExecFailure;
        if (typeof failure.code === "number") {
          resume(Effect.succeed({ exitCode: failure.code, stdout, stderr }));
          return;
        }
        resume(
          Effect.fail(
            new GitError({
              args: [...args],
              cwd,
              exitCode: null,
              stderr: (stderr === "" ? (failure.message ?? "") : stderr).trim(),
              ...endedBy(failure),
            }),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

/** How a git run that concluded nothing ended, in a few words: its signal, code, exit, last line. */
export const gitHostFaultWords = (error: GitError): string =>
  [
    error.signal === undefined ? null : `signal ${error.signal}`,
    error.code ?? null,
    error.exitCode === null ? null : `exit ${error.exitCode}`,
    error.stderr.split("\n").at(-1) ?? null,
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");

/** How much of a quiet run's stderr is kept: its tail, where git's `fatal:` line is. */
const QUIET_STDERR_BYTES = 64 * 1024;

/**
 * Run git for its exit alone: stdout is discarded as git writes it, never buffered, so a walk
 * whose output has no bound (`rev-list --objects` over a repository of millions of objects prints
 * 41 bytes an object) cannot overrun a buffer and be killed for it (review 2026-09-28 (13) #1:
 * 1.7M objects print 70 MB, past `git`'s 64 MiB). Succeeds with the count of bytes git printed;
 * fails as `git` does, keeping the tail of stderr.
 */
export const gitQuiet = (
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<number, GitError> =>
  Effect.callback<number, GitError>((resume) => {
    let printed = 0;
    let stderr = Buffer.alloc(0);
    let settled = false;
    const settle = (effect: Effect.Effect<number, GitError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const child = spawn("git", [...args], {
      cwd,
      env: gitProcessEnv(undefined),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      printed += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const joined = Buffer.concat([stderr, chunk]);
      stderr = joined.subarray(Math.max(0, joined.length - QUIET_STDERR_BYTES));
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      settle(
        Effect.fail(
          new GitError({
            args: [...args],
            cwd,
            exitCode: null,
            stderr: error.message,
            ...(typeof error.code === "string" ? { code: error.code } : {}),
          }),
        ),
      ),
    );
    child.on("close", (exitCode, signal) => {
      if (exitCode === 0) {
        settle(Effect.succeed(printed));
        return;
      }
      settle(
        Effect.fail(
          new GitError({
            args: [...args],
            cwd,
            exitCode,
            stderr: stderr.toString("utf8").trim(),
            ...(signal === null ? {} : { signal }),
          }),
        ),
      );
    });
    return Effect.sync(() => child.kill());
  });
