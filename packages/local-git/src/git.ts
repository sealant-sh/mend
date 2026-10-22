import { spawnSync } from "node:child_process";
import * as os from "node:os";

/**
 * Several times the slowest command a handoff runs (a status of every untracked file in a large,
 * cold checkout, or a bundle up to the server's 64 MiB default), and finite, so a git that hangs
 * frees its caller.
 */
export const HANDOFF_GIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface GitRuntime {
  readonly git?: string;
  /** Per git command; default HANDOFF_GIT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * Read before every git command; true stops the work there. Git runs under spawnSync, which
   * blocks the thread, so in a worker this must read shared memory (Atomics.load on a
   * SharedArrayBuffer) to see a cancel another thread made.
   */
  readonly cancelled?: () => boolean;
  /** The environment git inherits, without its GIT_ variables. Default process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export type Refused = { readonly _tag: "refused"; readonly message: string };
export type Cancelled = { readonly _tag: "cancelled" };

export const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.splitIndex=false",
  "core.untrackedCache=false",
  "gc.auto=0",
  `core.hooksPath=${os.devNull}`,
  "log.showSignature=false",
];

export class GitFailure extends Error {
  readonly words: string;
  constructor(command: string, words: string) {
    super(`git ${command} failed · ${words}`);
    this.words = words;
  }
}

class GitUnanswered extends Error {}

class Cancellation extends Error {}

export type Env = Readonly<Record<string, string>>;

export interface Runtime {
  readonly git: string;
  readonly timeoutMs: number;
  readonly cancelled: () => boolean;
  readonly env: NodeJS.ProcessEnv;
}

export const runtimeOf = (runtime: GitRuntime = {}): Runtime => {
  const timeoutMs = runtime.timeoutMs ?? HANDOFF_GIT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`timeoutMs is ${timeoutMs}; it must be a positive number of milliseconds`);
  }
  return {
    git: runtime.git ?? "git",
    timeoutMs,
    cancelled: runtime.cancelled ?? (() => false),
    env: runtime.env ?? process.env,
  };
};

const durationOf = (ms: number): string =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;

export interface Git {
  readonly run: (env: Env, args: ReadonlyArray<string>, input?: Buffer | string) => Buffer;
  readonly attempt: (
    env: Env,
    args: ReadonlyArray<string>,
    absentExit: number,
    absentSays?: string,
  ) => string | null;
}

export const gitIn = (cwd: string, config: ReadonlyArray<string>, runtime: Runtime): Git => {
  const spawn = (env: Env, args: ReadonlyArray<string>, input?: Buffer | string) => {
    if (runtime.cancelled()) throw new Cancellation();
    const command = args[0] ?? "";
    const result = spawnSync(runtime.git, [...config.flatMap((pair) => ["-c", pair]), ...args], {
      cwd,
      env,
      maxBuffer: 1 << 30,
      timeout: runtime.timeoutMs,
      killSignal: "SIGKILL",
      ...(input === undefined ? {} : { input }),
    });
    if (result.error !== undefined) {
      const timedOut = "code" in result.error && result.error.code === "ETIMEDOUT";
      throw new GitUnanswered(
        timedOut
          ? `git ${command} timed out after ${durationOf(runtime.timeoutMs)}`
          : `git ${command} could not run · ${result.error.message}`,
      );
    }
    if (result.status === null) {
      throw new GitUnanswered(`git ${command} was killed by ${result.signal ?? "a signal"}`);
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString() };
  };
  const failure = (args: ReadonlyArray<string>, status: number, stderr: string) => {
    const words = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("hint:"))
      .join(" · ");
    return new GitFailure(args[0] ?? "", words || `exit ${status}`);
  };
  return {
    run: (env, args, input) => {
      const result = spawn(env, args, input);
      if (result.status !== 0) throw failure(args, result.status, result.stderr);
      return result.stdout;
    },
    attempt: (env, args, absentExit, absentSays) => {
      const result = spawn(env, args);
      if (result.status === 0) return result.stdout.toString();
      if (
        result.status === absentExit &&
        (absentSays === undefined || result.stderr.includes(absentSays))
      ) {
        return null;
      }
      throw failure(args, result.status, result.stderr);
    },
  };
};

export const scrubbed = (inherited: NodeJS.ProcessEnv): Env => {
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

export const refused = (message: string): Refused => ({ _tag: "refused", message });

export const settled = <A>(work: () => A | Refused): A | Refused | Cancelled => {
  try {
    return work();
  } catch (error) {
    if (error instanceof Cancellation) return { _tag: "cancelled" };
    if (error instanceof GitFailure || error instanceof GitUnanswered) {
      return refused(`${error.message} · nothing was created`);
    }
    throw error;
  }
};
