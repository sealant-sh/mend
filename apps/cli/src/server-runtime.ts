import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Captured process result. Expected spawn failures do not reject. */
export interface ServerProcessOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** Finite command budgets. Compose gets its own shorter health-wait budget within startup. */
export const serverProcessDeadlines = {
  ordinary: 30_000,
  pull: 10 * 60_000,
  startup: 3 * 60_000,
  stop: 90_000,
  dump: 15 * 60_000,
  composeWaitSeconds: 120,
} as const;
/** Optional stdout destination: a private exclusive file, or the terminal. stderr always remains bounded. */
export interface ServerProcessOptions {
  /** Finite wall-clock budget, defaulting to ordinary commands even with a stdout file. */
  readonly timeoutMs?: number;
  readonly stdoutFile?: string;
  /** Show the child's stdout on the terminal instead of capturing it, so long pulls render Docker's own progress. */
  readonly stdout?: "inherit";
}

/**
 * Run Docker with a controlled environment. Shell interpolation and COMPOSE_* / DOCKER_HOST
 * cannot override persisted configuration. Context credentials still come from Docker's config.
 * Capture the parent environment once at the lifecycle command boundary and pass it here.
 * Every command has a deadline. On POSIX each child owns a new process group; timeout kills
 * that group, not just the Docker client. Await close to reap the child and drain inherited
 * pipes before returning to a caller that may release an installation lock.
 */
export const runServerProcess = (
  command: string,
  args: ReadonlyArray<string>,
  parentEnvironment: NodeJS.ProcessEnv,
  options: ServerProcessOptions = {},
): Promise<ServerProcessOutput> => {
  const timeoutMs = options?.timeoutMs ?? serverProcessDeadlines.ordinary;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.resolve({
      status: null,
      stdout: "",
      stderr: "",
      error: "Invalid process timeout",
    });
  }
  if (options.stdoutFile !== undefined && options.stdout === "inherit") {
    return Promise.resolve({
      status: null,
      stdout: "",
      stderr: "",
      error: "Invalid process output options",
    });
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "DOCKER_CONFIG",
    "SSH_AUTH_SOCK",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    if (parentEnvironment[key] !== undefined) env[key] = parentEnvironment[key];
  }
  return new Promise((resolve) => {
    let fd: number | undefined;
    try {
      if (options.stdoutFile !== undefined) fd = fs.openSync(options.stdoutFile, "wx", 0o600);
      const child = spawn(command, [...args], {
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", fd ?? (options.stdout === "inherit" ? "inherit" : "pipe"), "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: string | undefined;
      const terminate = (): void => {
        if (process.platform === "win32" || child.pid === undefined) {
          child.kill("SIGKILL");
          return;
        }
        try {
          // A negative PID addresses only the group created by this spawn, even if its leader exited.
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
            failure =
              "Could not terminate the process group; retain the installation lock until its processes stop.";
            child.kill("SIGKILL");
          }
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= 4 * 1024 * 1024) stdout += chunk.toString();
        else {
          failure ??= "Process output exceeded the capture limit. Request fewer log lines.";
          terminate();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= 64 * 1024) stderr += chunk.toString();
        else {
          failure ??= "Process output exceeded the capture limit. Request fewer log lines.";
          terminate();
        }
      });
      const timer = setTimeout(() => {
        failure ??= `Process timed out after ${timeoutMs}ms`;
        terminate();
      }, timeoutMs);
      // Even spawn errors emit close. Cleanup must not race a still-running Docker command.
      child.once("error", (error) => {
        failure ??= error.message;
      });
      child.once("close", (status) => {
        globalThis.clearTimeout(timer);
        try {
          if (fd !== undefined) fs.fsyncSync(fd);
        } catch {
          failure ??= "Could not durably write process output.";
        } finally {
          try {
            if (fd !== undefined) fs.closeSync(fd);
          } catch {
            failure ??= "Could not close process output file.";
          }
        }
        resolve({
          status: failure === undefined ? status : null,
          stdout,
          stderr,
          ...(failure === undefined ? {} : { error: failure }),
        });
      });
    } catch (cause) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        /* Report the original acquisition/spawn failure. */
      }
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        error: cause instanceof Error ? cause.message : "Could not start process.",
      });
    }
  });
};

/**
 * Build every lifecycle Compose invocation against one immutable generation and explicit context.
 * `overlays` are the generation's own files merged after `compose.yaml`, in order: the edge and the
 * posture, when the config declares them. The same list goes to every command, so a start, a
 * restart and an upgrade never recreate `mend` without them.
 */
export const serverComposeArgs = (
  installation: {
    readonly directory: string;
    readonly dockerContext: string;
    readonly overlays?: ReadonlyArray<string>;
  },
  command: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "--context",
  installation.dockerContext,
  "compose",
  "--project-name",
  "mend",
  "--project-directory",
  installation.directory,
  "--env-file",
  path.join(installation.directory, "server.env"),
  "-f",
  path.join(installation.directory, "compose.yaml"),
  ...(installation.overlays ?? []).flatMap((file) => [
    "-f",
    path.join(installation.directory, file),
  ]),
  ...command,
];
