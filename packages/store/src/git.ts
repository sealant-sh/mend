import { execFile } from "node:child_process";

import { Effect, Schema } from "effect";

/** A git invocation that exited nonzero (or could not run at all). */
export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  stderr: Schema.String,
}) {}

interface ExecFailure {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly message?: string;
}

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
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "mend",
          GIT_AUTHOR_EMAIL: "mend@localhost",
          GIT_COMMITTER_NAME: "mend",
          GIT_COMMITTER_EMAIL: "mend@localhost",
          ...env,
        },
      },
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
            }),
          ),
        );
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    return Effect.sync(() => child.kill());
  });
