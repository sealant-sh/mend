import { spawn } from "node:child_process";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const unrefDelay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds).unref());

const describeExit = ({ code, signal, error }) => {
  if (error !== undefined) return error.message;
  if (signal !== null) return `signal ${signal}`;
  return `exit code ${String(code)}`;
};

/** Error raised when a supervised long-running process exits. */
export class ChildProcessFailure extends Error {
  /**
   * @param {{ name: string, code: number | null, signal: NodeJS.Signals | null, error?: Error }} result
   */
  constructor(result) {
    super(`${result.name} stopped unexpectedly (${describeExit(result)})`);
    this.name = "ChildProcessFailure";
    this.result = result;
  }
}

/**
 * Owns a set of process groups. An unexpected long-running child exit becomes one fatal result,
 * and shutdown signals every remaining group before applying a kill deadline.
 */
export class ProcessSupervisor {
  #children = new Map();
  #failureResolve;
  #stopping = false;

  constructor() {
    this.failure = new Promise((resolve) => {
      this.#failureResolve = resolve;
    });
  }

  /** Resolves with the first unexpected long-running child exit. */
  failure;

  /** True after shutdown begins. */
  get stopping() {
    return this.#stopping;
  }

  /** Start a process whose exit must stop the whole process set. */
  async start(specification) {
    return this.#spawn(specification, true);
  }

  /**
   * Keep an optional process running: its exit is never fatal to the set, and neither is a start
   * that fails, the first included (review 643-2: a spawn refused for want of processes or
   * descriptors must not stop Mend beside it). It is started again after `backoffMs`, doubled
   * each time it ends before it ran `steadyMs` (to `maxBackoffMs`), until shutdown. For a part an
   * operator turned on beside Mend (the t3code gateway). `beforeStart` runs before each start, the
   * first and every restart; when it throws, that start fails like a spawn that fails. Resolves
   * once the first start was tried; never rejects.
   */
  async keepRunning(
    specification,
    {
      backoffMs = 1_000,
      maxBackoffMs = 60_000,
      steadyMs = 60_000,
      log = console.error,
      beforeStart = async () => {},
    } = {},
  ) {
    const attempt = async () => {
      try {
        if (this.#stopping)
          throw new Error(`cannot start ${specification.name}: shutdown has begun`);
        await beforeStart();
        return await this.#spawn(specification, false);
      } catch (error) {
        if (!this.#stopping) {
          log(`[supervisor] ${specification.name} did not start: ${String(error)}`);
        }
        return {
          exited: Promise.resolve({ name: specification.name, code: null, signal: null, error }),
        };
      }
    };
    let wait = backoffMs;
    const first = await attempt();
    void (async () => {
      let tracked = first;
      for (;;) {
        const startedAt = Date.now();
        const result = await tracked.exited;
        if (this.#stopping) return;
        wait = Date.now() - startedAt >= steadyMs ? backoffMs : Math.min(wait * 2, maxBackoffMs);
        log(
          `[supervisor] ${specification.name} ended (${describeExit(result)}); again in ${wait} ms`,
        );
        await unrefDelay(wait);
        if (this.#stopping) return;
        tracked = await attempt();
      }
    })();
    return first;
  }

  /** Run a startup process to completion without treating its expected exit as fatal. */
  async run(specification) {
    const tracked = await this.#spawn(specification, false);
    const result = await tracked.exited;
    if (result.error !== undefined || result.signal !== null || result.code !== 0) {
      throw new ChildProcessFailure(result);
    }
  }

  async #spawn(specification, fatalOnExit) {
    if (this.#stopping) throw new Error(`cannot start ${specification.name}: shutdown has begun`);
    const [command, ...arguments_] = specification.command;
    if (command === undefined) throw new Error(`${specification.name} has no command`);

    let resolveExit;
    const exited = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const child = spawn(command, arguments_, {
      cwd: specification.cwd,
      env: specification.env,
      stdio: specification.stdio ?? "inherit",
      detached: process.platform !== "win32",
    });
    const tracked = { name: specification.name, child, exited, fatalOnExit };
    this.#children.set(child.pid ?? Symbol(specification.name), tracked);

    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      for (const [key, candidate] of this.#children) {
        if (candidate === tracked) this.#children.delete(key);
      }
      resolveExit(result);
      if (fatalOnExit && !this.#stopping) this.#failureResolve(result);
    };

    child.once("error", (error) =>
      finish({ name: specification.name, code: null, signal: null, error }),
    );
    child.once("exit", (code, signal) => finish({ name: specification.name, code, signal }));

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return tracked;
  }

  /**
   * Poll a readiness assertion while also watching for a fatal child exit.
   *
   * @param {string} description
   * @param {() => Promise<boolean>} assertion
   * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
   */
  async waitFor(description, assertion, options = {}) {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const intervalMs = options.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        assertion().catch(() => false),
        this.failure.then((result) => {
          throw new ChildProcessFailure(result);
        }),
      ]);
      if (outcome) return;
      await delay(intervalMs);
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  /** Signal every process group, then SIGKILL groups that outlive the grace period. */
  async shutdown(signal = "SIGTERM", graceMs = 15_000) {
    if (this.#stopping) return;
    this.#stopping = true;
    const tracked = [...this.#children.values()];
    for (const managed of tracked) signalGroup(managed.child, signal);

    const settled = Promise.allSettled(tracked.map((managed) => managed.exited));
    const completed = await Promise.race([
      settled.then(() => true),
      unrefDelay(graceMs).then(() => false),
    ]);
    if (completed) return;

    for (const managed of tracked) signalGroup(managed.child, "SIGKILL");
    await Promise.race([settled, unrefDelay(2_000)]);
  }
}

const signalGroup = (child, signal) => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

/** Run a configured process set until one child exits or the parent receives SIGINT/SIGTERM. */
export const supervise = async (start, { shutdownGraceMs = 15_000 } = {}) => {
  const supervisor = new ProcessSupervisor();
  let terminating = false;

  const terminate = async (exitCode, signal) => {
    if (terminating) return;
    terminating = true;
    await supervisor.shutdown(signal, shutdownGraceMs);
    process.exitCode = exitCode;
  };

  const onInterrupt = () => {
    void terminate(0, "SIGINT");
  };
  const onTerminate = () => {
    void terminate(0, "SIGTERM");
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    await start(supervisor);
    const result = await supervisor.failure;
    throw new ChildProcessFailure(result);
  } catch (error) {
    if (!terminating) {
      console.error(`[supervisor] ${error instanceof Error ? error.message : String(error)}`);
      await terminate(1, "SIGTERM");
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
};
