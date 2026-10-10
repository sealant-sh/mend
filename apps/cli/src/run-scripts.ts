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

/**
 * The row of one process in a session read: the current agent or one of its processes. Where
 * both list it, a row that says it ended wins: the end is the fact being waited for.
 */
export const processRowOf = (
  detail: CommandDetail,
  processId: string,
): CommandProcess | undefined => {
  const rows = [
    ...(detail.currentAgent === null ? [] : [detail.currentAgent]),
    ...(detail.processes ?? []),
  ].filter((row) => row.id === processId);
  return rows.find((row) => row.exitedAt !== null) ?? rows[0];
};

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
 *
 * With `processId`, only that process's end counts: the one `mend run` started, or the one a
 * script named. Without it, a session that is `starting` (a launch or a resume under way) has not
 * ended, whatever its current agent says: until the new process's row exists, the current agent is
 * the previous one, already exited.
 */
export const commandEndOf = (
  detail: CommandDetail,
  processId: string | null = null,
): CommandEnd | null => {
  const settled = SETTLED.has(detail.session.status);
  if (processId !== null) {
    const target = processRowOf(detail, processId);
    if (target !== undefined && target.exitedAt !== null) {
      return { processId, status: target.status, exitCode: target.exitCode };
    }
    if (settled) {
      return { processId, status: detail.session.status, exitCode: target?.exitCode ?? null };
    }
    return null;
  }
  if (detail.session.status === "starting") return null;
  const agent = detail.currentAgent;
  if (agent !== null && agent.exitedAt !== null) {
    return { processId: agent.id ?? null, status: agent.status, exitCode: agent.exitCode };
  }
  if (settled) {
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
  /** Resolves after `ms`, or at once, early, when `signal` aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** How long reads may fail in a row before giving up. */
  readonly unreachableAfterMs?: number;
  readonly pollMs?: number;
}

/** What a bounded step came to: its value, or the deadline passed first. */
export type Bounded<T> = { readonly done: true; readonly value: T } | { readonly done: false };

/**
 * `work`, unless the deadline (on `clock`'s time) passes first. Null waits for it. A step the
 * deadline beat is left to finish on its own; nothing reads its answer.
 */
export const beforeDeadline = async <T>(
  work: Promise<T>,
  clock: Pick<Clock, "now" | "sleep">,
  deadline: number | null,
): Promise<Bounded<T>> => {
  if (deadline === null) return { done: true, value: await work };
  const left = deadline - clock.now();
  if (left <= 0) {
    work.catch(() => undefined);
    return { done: false };
  }
  // The deadline's timer goes as soon as the work answers: nothing waits on it after.
  const timer = new AbortController();
  try {
    return await Promise.race([
      work.then((value): Bounded<T> => ({ done: true, value })),
      clock.sleep(left, timer.signal).then((): Bounded<T> => ({ done: false })),
    ]);
  } finally {
    timer.abort();
  }
};

/**
 * One read, retried while it fails without an answer (a timeout, an edge cutting it, a restart)
 * for up to `unreachableAfterMs`. A refusal is thrown at once. The deadline bounds every attempt,
 * in flight or not, and every pause between them.
 */
const readThrough = async <T>(
  read: () => Promise<T>,
  clock: Clock,
  deadline: number | null,
): Promise<Bounded<T>> => {
  const unreachableAfterMs = clock.unreachableAfterMs ?? 60_000;
  const since = clock.now();
  for (;;) {
    try {
      return await beforeDeadline(read(), clock, deadline);
    } catch (error) {
      if (isRefusal(error) || clock.now() - since >= unreachableAfterMs) throw error;
      const pause =
        deadline === null
          ? (clock.pollMs ?? 1000)
          : Math.min(clock.pollMs ?? 1000, deadline - clock.now());
      if (pause <= 0) return { done: false };
      await clock.sleep(pause);
    }
  }
};

/** The value of a read no deadline bounds. */
const unbounded = async <T>(read: () => Promise<T>, clock: Clock): Promise<T> => {
  const got = await readThrough(read, clock, null);
  if (!got.done) throw new Error("a read with no deadline timed out");
  return got.value;
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
  /**
   * Resolves once the bytes are handed on (for stdout: written to the pipe or the terminal), so a
   * slow reader holds the next page back instead of letting output queue up in memory.
   */
  readonly write: (bytes: Uint8Array) => Promise<void>;
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
    const page = await unbounded(() => options.read(from), options);
    for (const chunk of page.chunks) await options.write(Buffer.from(chunk.dataBase64, "base64"));
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
  /** The deadline passed first; `last` is the last read that answered, if any did. */
  | { readonly kind: "timeout"; readonly last: CommandDetail | null };

export interface WaitOptions extends Clock {
  readonly read: () => Promise<CommandDetail>;
  /** Only this process's end counts (`commandEndOf`); null takes the session's command. */
  readonly processId: string | null;
  /**
   * When to give up, on the clock's time; null waits as long as the command runs. One deadline
   * for every read, retry and pause: nothing outlives it.
   */
  readonly deadline: number | null;
}

/** Read the session until its command has ended, or the deadline passes. */
export const waitForCommand = async (options: WaitOptions): Promise<WaitOutcome> => {
  const pollMs = options.pollMs ?? 1000;
  let last: CommandDetail | null = null;
  for (;;) {
    const got = await readThrough(options.read, options, options.deadline);
    if (!got.done) return { kind: "timeout", last };
    last = got.value;
    const end = commandEndOf(got.value, options.processId);
    if (end !== null) return { kind: "ended", end };
    const left =
      options.deadline === null ? pollMs : Math.min(pollMs, options.deadline - options.now());
    if (left <= 0) return { kind: "timeout", last };
    await options.sleep(left);
  }
};

// ─── arguments ──────────────────────────────────────────────────────────────

export interface LogsArgs {
  readonly session: string | null;
  readonly follow: boolean;
  readonly from: string;
  readonly process: string | null;
  /** `--service <name-or-id>`: the Service's current attempt. */
  readonly service: string | null;
}

export interface WaitArgs {
  readonly session: string | null;
  /** `--process <id>`: wait for this process's end, not the session's current command. */
  readonly process: string | null;
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

/** `mend logs [session] [--follow|-f] [--from <sequence>] [--process <id> | --service <name>]`. */
export const parseLogsArgs = (args: ReadonlyArray<string>): Parsed<LogsArgs> => {
  const split = splitArgs(args, ["--from", "--process", "--service"], ["--follow", "-f"]);
  if ("error" in split) return split;
  const from = split.values.get("--from") ?? "0";
  if (!/^(0|[1-9]\d*)$/u.test(from)) return { error: "--from takes a record sequence, e.g. 0" };
  const process = split.values.get("--process") ?? null;
  const service = split.values.get("--service") ?? null;
  if (process !== null && service !== null) {
    return { error: "--process and --service each name one process; pass one of them" };
  }
  return {
    args: {
      session: split.session,
      follow: split.on.has("--follow") || split.on.has("-f"),
      from,
      process,
      service,
    },
  };
};

/** `mend wait [session] [--timeout <duration>] [--process <id>] [--json]`. */
export const parseWaitArgs = (args: ReadonlyArray<string>): Parsed<WaitArgs> => {
  const split = splitArgs(args, ["--timeout", "--process"], ["--json"]);
  if ("error" in split) return split;
  const timeout = split.values.get("--timeout");
  const timeoutMs = timeout === undefined ? null : parseDuration(timeout);
  if (timeoutMs === null && timeout !== undefined) return { error: DURATION_ISSUE };
  return {
    args: {
      session: split.session,
      process: split.values.get("--process") ?? null,
      timeoutMs,
      json: split.on.has("--json"),
    },
  };
};

const DURATION_UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * A `--timeout` in milliseconds, or null when it is not one: `90` and `90s` are seconds, `5m`
 * minutes, `1h` hours, fractions allowed (`.5`, `1.5m`), above 0. `mend wait` and `mend service run --wait` read
 * it the same way.
 */
export const parseDuration = (text: string): number | null => {
  const trimmed = text.trim();
  const unit = DURATION_UNIT_MS[trimmed.slice(-1)];
  // A bare number is seconds, read as `mend wait` always read it (`.5`, `1e2`).
  const amount =
    unit === undefined
      ? trimmed === ""
        ? Number.NaN
        : Number(trimmed)
      : /^(?:\d+\.?\d*|\.\d+)$/u.test(trimmed.slice(0, -1))
        ? Number(trimmed.slice(0, -1))
        : Number.NaN;
  const ms = Math.ceil(amount * (unit ?? 1000));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export const DURATION_ISSUE = "--timeout takes a duration above 0: 90 or 90s, 5m, 1h";

/** `10 min`, `90 s`, `1 h 30 min`: a duration as the CLI says it. */
export const durationLine = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
};

/**
 * The exit status `mend wait` and `mend service run --wait` give when the timeout passed first, as
 * `timeout(1)` does. What was waited for keeps running.
 */
export const WAIT_TIMED_OUT = 124;

/** A full session id: one `GET /sessions/:id` finds it, settled or not. */
export const isSessionId = (word: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(word);

// ─── a Service's start ──────────────────────────────────────────────────────

/**
 * How `mend service run --wait` ends, beyond 0 (the port answered), 1 (Mend refused the start or
 * could not be asked) and `WAIT_TIMED_OUT` (still starting when the timeout passed).
 */
export const SERVICE_PROCESS_ENDED = 2;
export const SERVICE_WORKSPACE_ENDED = 3;

/** The slice of a Service's view (`GET /services`) a wait and `mend logs --service` read. */
export interface ServiceViewSlice {
  readonly service: {
    readonly id: string;
    readonly sessionId: string;
    readonly name: string;
    readonly currentAttemptId: string | null;
  };
  readonly attempts: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly exitCode?: number | null;
    readonly exitedAt: string | null;
    readonly sealantSessionId: string | null;
    readonly createdAt?: string;
    /** `service-start:<startId>` on an attempt a start began under its client's id. */
    readonly launchCorrelationId?: string | null;
  }>;
  readonly currentForward: { readonly id: string } | null;
  readonly latestObservation: {
    readonly forwardId: string;
    readonly state: string;
    readonly lastObservedAt?: string;
  } | null;
}

/** One read of a starting Service: every Service listed, ended ones included, and its session. */
export interface ServiceStartRead<V extends ServiceViewSlice = ServiceViewSlice> {
  readonly services: ReadonlyArray<V>;
  /** The session's status, or null once the server no longer has the session. */
  readonly sessionStatus: string | null;
}

/**
 * The one attempt a wait judges: the attempt this client's start began. `attemptId` once known
 * (the start answered with it, or a read found it); until then `correlation`, the launch
 * correlation the server stamps on the attempt a start began under its client's id. Never
 * whichever attempt is current: another client may have started, restarted or stopped the Service.
 */
export interface ServiceStartTarget {
  readonly attemptId: string | null;
  /** `serviceStartCorrelation(startId)`; null against a server that answered without one. */
  readonly correlation: string | null;
}

/** The attempt `target` names, and the Service it belongs to, in what one read listed. */
export const findStartAttempt = <V extends ServiceViewSlice>(
  services: ReadonlyArray<V>,
  target: ServiceStartTarget,
): { readonly view: V; readonly attempt: V["attempts"][number] } | undefined => {
  for (const view of services) {
    const attempt = view.attempts.find((candidate) =>
      target.attemptId !== null
        ? candidate.id === target.attemptId
        : target.correlation !== null && candidate.launchCorrelationId === target.correlation,
    );
    if (attempt !== undefined) return { view, attempt };
  }
  return undefined;
};

/**
 * The attempt a start answered with: the one carrying the start's correlation, or, from a server
 * older than start ids, the Service's current attempt as that very answer read it.
 */
export const answeredAttemptId = (view: ServiceViewSlice, correlation: string): string | null => {
  const own = view.attempts.find((attempt) => attempt.launchCorrelationId === correlation);
  if (own !== undefined) return own.id;
  // A server that stamps start ids stamped this start's attempt; only an older one stamps none.
  const kind = correlation.slice(0, correlation.indexOf(":") + 1);
  const stamps = view.attempts.some(
    (attempt) => attempt.launchCorrelationId?.startsWith(kind) === true,
  );
  return stamps ? null : view.service.currentAttemptId;
};

const timeOf = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
};

/**
 * Whether the port answered for this attempt: the attempt is the Service's current one, the
 * observation is of the Service's current forward, says `reachable`, and was made after the
 * attempt began (a restart keeps its predecessor's forward and, until its own probe, its
 * predecessor's observation). A server that sends no times is taken at its observation.
 */
const answeredFor = (
  view: ServiceViewSlice,
  attempt: ServiceViewSlice["attempts"][number],
): boolean => {
  const observation = view.latestObservation;
  if (view.service.currentAttemptId !== attempt.id || view.currentForward === null) return false;
  if (observation === null || observation.forwardId !== view.currentForward.id) return false;
  if (observation.state !== "reachable") return false;
  const began = timeOf(attempt.createdAt);
  const observed = timeOf(observation.lastObservedAt);
  return began === null || observed === null || observed >= began;
};

export type ServiceStartState<V extends ServiceViewSlice = ServiceViewSlice> =
  | { readonly kind: "answered"; readonly processId: string; readonly view: V }
  /** Its process runs and its port has not answered: building, installing, booting. */
  | { readonly kind: "starting"; readonly processId: string | null }
  | {
      readonly kind: "process-ended";
      readonly processId: string;
      readonly status: string;
      readonly exitCode: number | null;
    }
  /** The server no longer has the session: it went, its workspace with it. */
  | { readonly kind: "workspace-ended"; readonly sessionStatus: null };

/**
 * What one read says about the attempt a start began. Its own end comes first, whatever the session
 * reads: a session settles when its last process ends, while a workspace another session shares
 * stays up, so a settled session is no evidence the workspace ended first. A session the server no
 * longer has took its workspace with it. Then the port answering for this attempt. Anything else is
 * still starting.
 */
export const serviceStartStateOf = <V extends ServiceViewSlice>(
  read: ServiceStartRead<V>,
  target: ServiceStartTarget,
): ServiceStartState<V> => {
  const found = findStartAttempt(read.services, target);
  if (found !== undefined && found.attempt.exitedAt !== null) {
    return {
      kind: "process-ended",
      processId: found.attempt.id,
      status: found.attempt.status,
      exitCode: found.attempt.exitCode ?? null,
    };
  }
  if (read.sessionStatus === null) return { kind: "workspace-ended", sessionStatus: null };
  if (found === undefined) return { kind: "starting", processId: target.attemptId };
  return answeredFor(found.view, found.attempt)
    ? { kind: "answered", processId: found.attempt.id, view: found.view }
    : { kind: "starting", processId: found.attempt.id };
};

export type ServiceWaitOutcome<V extends ServiceViewSlice = ServiceViewSlice> =
  | Exclude<ServiceStartState<V>, { readonly kind: "starting" }>
  /** The deadline passed while the Service was still starting; `last` is the last state read. */
  | { readonly kind: "timeout"; readonly last: ServiceStartState<V> | null }
  /** The start got no answer, and no attempt of it appeared for `unreachableAfterMs`. */
  | { readonly kind: "no-attempt" };

export interface ServiceWaitOptions<V extends ServiceViewSlice> extends Clock {
  readonly read: () => Promise<ServiceStartRead<V>>;
  readonly target: ServiceStartTarget;
  /** When to give up, on the clock's time; null waits as long as the Service is starting. */
  readonly deadline: number | null;
  /** Called with each state read while the Service is still starting. */
  readonly onStarting?: (state: Extract<ServiceStartState, { readonly kind: "starting" }>) => void;
}

/**
 * Read a starting Service until its port answers for the attempt this start began, that attempt
 * ends, the session goes, or the deadline passes. The attempt is pinned the first time a read finds
 * it, and only it is judged from then on. A Service that is building, installing or booting keeps
 * the wait going however long that takes: only the deadline bounds it. Reads that get no answer are
 * retried, as `mend wait` does, and a refusal is thrown.
 */
export const waitForServiceStart = async <V extends ServiceViewSlice>(
  options: ServiceWaitOptions<V>,
): Promise<ServiceWaitOutcome<V>> => {
  const pollMs = options.pollMs ?? 2000;
  const discoverWithinMs = options.unreachableAfterMs ?? 60_000;
  const since = options.now();
  let target = options.target;
  let last: ServiceStartState<V> | null = null;
  for (;;) {
    const got = await readThrough(options.read, options, options.deadline);
    if (!got.done) return { kind: "timeout", last };
    const state = serviceStartStateOf(got.value, target);
    if (state.kind !== "starting") return state;
    last = state;
    if (state.processId === null) {
      if (options.now() - since >= discoverWithinMs) return { kind: "no-attempt" };
    } else if (target.attemptId === null) {
      target = { ...target, attemptId: state.processId };
    }
    options.onStarting?.(state);
    const left =
      options.deadline === null ? pollMs : Math.min(pollMs, options.deadline - options.now());
    if (left <= 0) return { kind: "timeout", last };
    await options.sleep(left);
  }
};

/**
 * One read, retried while it fails without an answer, within the deadline: the value, or
 * `{ done: false }` when the deadline passed first. A refusal is thrown at once.
 */
export const readWithin = <T>(
  read: () => Promise<T>,
  clock: Clock,
  deadline: number | null,
): Promise<Bounded<T>> => readThrough(read, clock, deadline);

const candidateLine = (view: ServiceViewSlice): string =>
  `${view.service.id} (session ${view.service.sessionId.slice(0, 8)})`;

/**
 * The process `mend logs --service` reads: the current attempt of the Service `needle` names. A
 * Service's full id names it before anything else (a Service may be named like another's id); then
 * a name, then a prefix of an id. Within `sessionId` when one is given. Two Services one word names
 * are refused, each listed by its full id, which names it alone.
 */
export const pickServiceAttempt = (
  services: ReadonlyArray<ServiceViewSlice>,
  needle: string,
  sessionId: string | null,
):
  | { readonly service: ServiceViewSlice; readonly processId: string }
  /** `named`: some Service answers to `needle`, and the error is about it. */
  | { readonly error: string; readonly named: boolean } => {
  const inScope = services.filter(
    (view) => sessionId === null || view.service.sessionId === sessionId,
  );
  const byId = inScope.filter((view) => view.service.id === needle);
  const byName = inScope.filter((view) => view.service.name === needle);
  const matches =
    byId.length > 0
      ? byId
      : byName.length > 0
        ? byName
        : inScope.filter((view) => view.service.id.startsWith(needle));
  const [chosen] = matches;
  if (chosen === undefined) {
    return {
      error: `no Service ${sessionId === null ? "" : "of this session "}is named "${needle}" or has an id starting with it`,
      named: false,
    };
  }
  if (matches.length > 1) {
    return {
      error: `"${needle}" names ${matches.length} Services · name one by its id: ${matches.map(candidateLine).join(", ")}`,
      named: true,
    };
  }
  const name = chosen.service.name;
  const attemptId = chosen.service.currentAttemptId;
  if (attemptId === null) {
    return {
      error: `Service ${name} has no attempt yet: Mend has run no process for it, so nothing is recorded (an adopted port has none; mend service run starts one)`,
      named: true,
    };
  }
  const attempt = chosen.attempts.find((candidate) => candidate.id === attemptId);
  if (attempt === undefined || attempt.sealantSessionId === null) {
    return {
      error: `Service ${name}'s attempt ${attemptId.slice(0, 8)} has not opened its terminal yet, so nothing is recorded · try again in a moment`,
      named: true,
    };
  }
  return { service: chosen, processId: attemptId };
};
