import { GATEWAY_STATUSES, MendRequestError } from "./server-request.ts";

/**
 * What a script needs from `mend run`, `mend logs` and `mend wait`: a command the platform will
 * take, checked before anything is created; the command's recorded terminal output, as bytes; and
 * the command's end, with its exit code. Kept free of the CLI's globals so each piece is tested on
 * its own.
 */

// ─── the command a run takes ────────────────────────────────────────────────

/** The most words the platform takes in one command (Core's `createSessionRequestSchema`). */
export const RUN_ARGV_MAX = 64;

const whitespaceName = (character: string): string =>
  character === "\n" || character === "\r"
    ? "a newline"
    : character === "\t"
      ? "a tab"
      : character === " "
        ? "a space"
        : "whitespace";

/**
 * Why the platform would refuse this command, or null when it takes it. Core's contract
 * (`createSessionRequestSchema`) asks for at most 64 words, each non-empty and with no leading or
 * trailing whitespace (`Schema.isTrimmed`, which is `s.trim() === s`). A refusal there comes after
 * the session exists, so `mend run` asks here first and creates nothing. The word is named by its
 * position, never quoted: a command can carry a secret.
 */
export const runArgvIssue = (argv: ReadonlyArray<string>): string | null => {
  if (argv.length > RUN_ARGV_MAX) {
    return `the command has ${argv.length} words and the platform takes at most ${RUN_ARGV_MAX} · put them in a script and run that`;
  }
  for (const [index, word] of argv.entries()) {
    const which = index === 0 ? "the program" : `argument ${index}`;
    if (word === "") {
      return `${which} is empty · the platform refuses empty arguments`;
    }
    if (word.trim() !== word) {
      const leading = word.trimStart() !== word;
      const edge = leading ? word.charAt(0) : word.charAt(word.length - 1);
      return `${which} ${leading ? "starts" : "ends"} with ${whitespaceName(edge)} · the platform refuses arguments with leading or trailing whitespace · trim it and run again`;
    }
  }
  return null;
};

// ─── a session's processes ──────────────────────────────────────────────────

/** The slice of a process row these commands read. */
export interface CommandProcess {
  readonly id?: string;
  readonly kind?: string;
  readonly label?: string | null;
  readonly status: string;
  readonly exitCode: number | null;
  readonly exitedAt: string | null;
  readonly sealantSessionId: string | null;
}

/** The slice of `GET /sessions/:id` these commands read. */
export interface CommandDetail {
  readonly session: { readonly id: string; readonly status: string };
  /** The process "the session's agent" means: for `mend run`, the command. */
  readonly currentAgent: CommandProcess | null;
  readonly processes?: ReadonlyArray<CommandProcess>;
}

/**
 * The process `mend logs` reads: the one whose id starts with `prefix`, else the session's
 * command (its current agent), else the newest process it held.
 */
export const pickProcess = (
  detail: CommandDetail,
  prefix: string | null,
): { readonly process: CommandProcess } | { readonly error: string } => {
  const processes = detail.processes ?? [];
  if (prefix !== null) {
    const matches = processes.filter((candidate) => candidate.id?.startsWith(prefix) === true);
    const [only] = matches;
    if (matches.length > 1) {
      return { error: `"${prefix}" matches ${matches.length} processes; type more of the id` };
    }
    if (only === undefined) return { error: `no process of this session matches "${prefix}"` };
    return { process: only };
  }
  const chosen = detail.currentAgent ?? processes.at(-1);
  if (chosen === undefined) return { error: "this session has run nothing yet" };
  return { process: chosen };
};

// ─── the command's end ──────────────────────────────────────────────────────

const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "stopped"]);

/** How a session's command ended, as the server observed it. */
export interface CommandEnd {
  readonly processId: string | null;
  /** The process's own last status (`exited`, `stopped`), or the session's when none ended. */
  readonly status: string;
  readonly exitCode: number | null;
}

/**
 * The command's end, or null while it runs: its process ended, or the session settled (a launch
 * that failed before anything ran, an executor that was lost). A session that reads `idle` while a
 * shell holds the workspace is answered by its command's own row.
 */
export const commandEndOf = (detail: CommandDetail): CommandEnd | null => {
  const agent = detail.currentAgent;
  if (agent !== null && agent.exitedAt !== null) {
    return { processId: agent.id ?? null, status: agent.status, exitCode: agent.exitCode };
  }
  if (SETTLED.has(detail.session.status)) {
    return {
      processId: agent?.id ?? null,
      status: detail.session.status,
      exitCode: agent?.exitCode ?? null,
    };
  }
  return null;
};

/**
 * The exit status a script gets: the command's own code, as the platform reported it. A code the
 * platform did not report, or one no process can exit with, reads as 1: nothing was observed to
 * succeed.
 */
export const exitStatusOf = (end: CommandEnd): number =>
  end.exitCode !== null &&
  Number.isInteger(end.exitCode) &&
  end.exitCode >= 0 &&
  end.exitCode <= 255
    ? end.exitCode
    : 1;

/** `exited · code 0`, or `stopped · no exit code reported`. */
export const endLine = (end: CommandEnd): string =>
  `${end.status} · ${end.exitCode === null ? "no exit code reported" : `code ${end.exitCode}`}`;

// ─── reading through blips ──────────────────────────────────────────────────

/** A call the server answered with a refusal (a 404, a 401): reading again will not change it. */
const isRefusal = (error: unknown): boolean =>
  error instanceof MendRequestError &&
  error.kind === "http" &&
  (error.status === null || !GATEWAY_STATUSES.has(error.status));

interface Clock {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** How long reads may fail in a row before giving up. */
  readonly unreachableAfterMs?: number;
  readonly pollMs?: number;
}

/**
 * One read, retried while it fails without an answer (a timeout, an edge cutting it, a restart)
 * for up to `unreachableAfterMs`. A refusal is thrown at once.
 */
const readThrough = async <T>(read: () => Promise<T>, clock: Clock): Promise<T> => {
  const unreachableAfterMs = clock.unreachableAfterMs ?? 60_000;
  const since = clock.now();
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (isRefusal(error) || clock.now() - since >= unreachableAfterMs) throw error;
      await clock.sleep(clock.pollMs ?? 1000);
    }
  }
};

// ─── recorded output ────────────────────────────────────────────────────────

/** The slice of `GET /processes/:id/logs` the follower reads. */
export interface LogPage {
  readonly nextFrom: string;
  readonly status: "exited" | "failed" | "running" | "starting";
  readonly chunks: ReadonlyArray<{ readonly sequence: string; readonly dataBase64: string }>;
}

export interface FollowLogsOptions extends Clock {
  /** The record sequence to start at. */
  readonly from: string;
  /** Keep reading until the process ends; false prints what is recorded now and returns. */
  readonly follow: boolean;
  readonly read: (from: string) => Promise<LogPage>;
  readonly write: (bytes: Uint8Array) => void;
  /**
   * Once the process ended, how many reads in a row must find nothing new before the follow
   * stops: the last output can reach the record a moment after the exit does.
   */
  readonly quietReadsAfterEnd?: number;
}

/**
 * Write a process's recorded terminal output from `from`: every page there is, then, when
 * following, each new page until the process has ended and the record stops moving. Returns the
 * next sequence and the process's last status.
 */
export const followLogs = async (
  options: FollowLogsOptions,
): Promise<{ readonly next: string; readonly status: LogPage["status"] }> => {
  const pollMs = options.pollMs ?? 250;
  const quietReadsAfterEnd = options.quietReadsAfterEnd ?? 2;
  let cursor = options.from;
  let quiet = 0;
  for (;;) {
    const from = cursor;
    const page = await readThrough(() => options.read(from), options);
    for (const chunk of page.chunks) options.write(Buffer.from(chunk.dataBase64, "base64"));
    const advanced = page.nextFrom !== cursor;
    cursor = page.nextFrom;
    // More may be recorded already: read again at once.
    if (advanced) {
      quiet = 0;
      continue;
    }
    if (!options.follow) return { next: cursor, status: page.status };
    if (page.status === "exited" || page.status === "failed") {
      quiet += 1;
      if (quiet >= quietReadsAfterEnd) return { next: cursor, status: page.status };
    }
    await options.sleep(pollMs);
  }
};

// ─── waiting for the end ────────────────────────────────────────────────────

export type WaitOutcome =
  | { readonly kind: "ended"; readonly end: CommandEnd }
  | { readonly kind: "timeout" };

export interface WaitOptions extends Clock {
  readonly read: () => Promise<CommandDetail>;
  /** Null waits as long as the command runs. */
  readonly timeoutMs: number | null;
}

/** Read the session until its command has ended, or the timeout passes. */
export const waitForCommand = async (options: WaitOptions): Promise<WaitOutcome> => {
  const pollMs = options.pollMs ?? 1000;
  const started = options.now();
  for (;;) {
    const end = commandEndOf(await readThrough(options.read, options));
    if (end !== null) return { kind: "ended", end };
    const left =
      options.timeoutMs === null
        ? pollMs
        : Math.min(pollMs, options.timeoutMs - (options.now() - started));
    if (left <= 0) return { kind: "timeout" };
    await options.sleep(left);
  }
};

// ─── arguments ──────────────────────────────────────────────────────────────

export interface LogsArgs {
  readonly session: string | null;
  readonly follow: boolean;
  readonly from: string;
  readonly process: string | null;
}

export interface WaitArgs {
  readonly session: string | null;
  /** Milliseconds; null waits as long as the command runs. */
  readonly timeoutMs: number | null;
  readonly json: boolean;
}

type Parsed<T> = { readonly args: T } | { readonly error: string };

/** Flags with a value, the rest switches; one positional, the session. */
const splitArgs = (
  args: ReadonlyArray<string>,
  valued: ReadonlyArray<string>,
  switches: ReadonlyArray<string>,
):
  | {
      readonly values: ReadonlyMap<string, string>;
      readonly on: ReadonlySet<string>;
      readonly session: string | null;
    }
  | { readonly error: string } => {
  const values = new Map<string, string>();
  const on = new Set<string>();
  let session: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (valued.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined) return { error: `${arg} needs a value` };
      values.set(arg, value);
      index += 1;
    } else if (switches.includes(arg)) {
      on.add(arg);
    } else if (arg.startsWith("-")) {
      return { error: `unknown flag ${arg}` };
    } else if (session !== null) {
      return { error: `one session only; "${arg}" is extra` };
    } else {
      session = arg;
    }
  }
  return { values, on, session };
};

/** `mend logs [session] [--follow|-f] [--from <sequence>] [--process <id>]`. */
export const parseLogsArgs = (args: ReadonlyArray<string>): Parsed<LogsArgs> => {
  const split = splitArgs(args, ["--from", "--process"], ["--follow", "-f"]);
  if ("error" in split) return split;
  const from = split.values.get("--from") ?? "0";
  if (!/^(0|[1-9]\d*)$/u.test(from)) return { error: "--from takes a record sequence, e.g. 0" };
  return {
    args: {
      session: split.session,
      follow: split.on.has("--follow") || split.on.has("-f"),
      from,
      process: split.values.get("--process") ?? null,
    },
  };
};

/** `mend wait [session] [--timeout <seconds>] [--json]`. */
export const parseWaitArgs = (args: ReadonlyArray<string>): Parsed<WaitArgs> => {
  const split = splitArgs(args, ["--timeout"], ["--json"]);
  if ("error" in split) return split;
  const timeout = split.values.get("--timeout");
  const seconds = timeout === undefined ? null : Number(timeout);
  if (seconds !== null && !(Number.isFinite(seconds) && seconds > 0)) {
    return { error: "--timeout takes a number of seconds above 0" };
  }
  return {
    args: {
      session: split.session,
      timeoutMs: seconds === null ? null : Math.ceil(seconds * 1000),
      json: split.on.has("--json"),
    },
  };
};

/** The exit status `mend wait` gives when the timeout passed first, as `timeout(1)` does. */
export const WAIT_TIMED_OUT = 124;

/** A full session id: one `GET /sessions/:id` finds it, settled or not. */
export const isSessionId = (word: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(word);
