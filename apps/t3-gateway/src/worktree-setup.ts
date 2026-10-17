import { randomUUID } from "node:crypto";

import {
  T3_PROJECT_FILE_NAME,
  T3ProjectFile,
  ThreadId,
  WORKTREE_SETUP_DETAIL_MAX_LENGTH,
  WORKTREE_SETUP_ERROR_MAX_LENGTH,
  WORKTREE_SETUP_STAGE_ORDER,
  WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
  type WorktreeSetupStageId,
  type WorktreeSetupStageStatus,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { GatedMend } from "./device-gate.ts";
import { makeFanout, type SubscriberFellBehind } from "./fanout.ts";
import type { BearerSession, ThreadLaunchOptions } from "./state.ts";
import type { TerminalFailure, Terminals } from "./terminals.ts";

/**
 * t3code's worktree setup (`subscribeWorktreeSetup`, `worktreeSetup.cancel`) over a Mend session.
 * t3code prepares a new thread's worktree in stages: fetch the base from origin, check out, run the
 * project's setup script, start the agent. The gateway does the same against Mend:
 *
 * - `fetch` is `POST /api/projects/:id/refresh` when the launch asks to start from origin, and
 *   `checkout` is `POST /api/projects/:id/sessions`, which makes the worktree.
 * - `setup-script` is the first `runOnWorktreeCreate` script of the new worktree's own t3.json. The
 *   gateway keeps no project scripts (t3code's settings), so the checkout's t3.json stands in for
 *   them. Mend runs no setup of its own when it makes a worktree.
 * - The script runs in a Mend shell beside the agent (`terminals.ts`), so the agent's workspace is
 *   started first; the opening message is not sent until the script has started, or, for a script
 *   t3.json marks `async: false`, until it has exited, as on t3code's own server.
 * - `agent` is that hand-off: done once the opening message may go.
 *
 * Snapshots are kept per thread in memory, published as they change, and dropped 30 seconds after
 * a setup ends, as t3code's tracker does; a client that sees `null` then reads the thread itself.
 */

const FINISHED_RETENTION = "30 seconds";
const TAIL_LINE_LIMIT = 4;
const PARTIAL_LINE_LIMIT = 4_096;

const clamp = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

const clampDetail = (detail: string | null): string | null =>
  detail === null ? null : clamp(detail, WORKTREE_SETUP_DETAIL_MAX_LENGTH);

const emptyStage = (id: WorktreeSetupStageId): WorktreeSetupStage => ({
  id,
  status: "pending",
  startedAt: null,
  endedAt: null,
  percent: null,
  detail: null,
  tail: [],
});

interface SetupChange {
  readonly threadId: string;
  readonly snapshot: WorktreeSetupSnapshot | null;
}

export interface WorktreeSetups {
  /** A setup starts for a thread, with the stages it will go through, in t3code's order. */
  readonly begin: (input: {
    readonly threadId: string;
    readonly branch: string | null;
    readonly baseRef: string | null;
    readonly stages: ReadonlyArray<WorktreeSetupStageId>;
  }) => Effect.Effect<void>;
  readonly update: (
    threadId: string,
    mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ) => Effect.Effect<void>;
  readonly stageStatus: (
    threadId: string,
    stageId: WorktreeSetupStageId,
    status: WorktreeSetupStageStatus,
    detail?: string | null,
  ) => Effect.Effect<void>;
  readonly appendTail: (
    threadId: string,
    stageId: WorktreeSetupStageId,
    line: string,
  ) => Effect.Effect<void>;
  /** The setup ended; a stage still running ends with it. */
  readonly finish: (
    threadId: string,
    phase: "done" | "failed" | "cancelled",
    error?: string | null,
  ) => Effect.Effect<void>;
  /** The fiber a cancel interrupts, or null once the setup can no longer be cancelled. */
  readonly cancellable: (
    threadId: string,
    fiber: Fiber.Fiber<unknown, unknown> | null,
  ) => Effect.Effect<void>;
  /** Interrupts a running setup that can still be cancelled; true once it was. */
  readonly cancel: (threadId: string) => Effect.Effect<boolean>;
  /** The thread's setup now, or null, then each change (`subscribeWorktreeSetup`). */
  readonly stream: (
    threadId: string,
  ) => Stream.Stream<WorktreeSetupSnapshot | null, SubscriberFellBehind>;
}

/** The person's setups; a finished one is dropped after its retention, in `scope`. */
export const makeWorktreeSetups = (scope: Scope.Scope): WorktreeSetups => {
  const setups = new Map<
    string,
    { snapshot: WorktreeSetupSnapshot; fiber: Fiber.Fiber<unknown, unknown> | null }
  >();
  // Sequences keep rising across setups of one thread, so a stream open during the last setup
  // takes the next one's first snapshot.
  const lastSequence = new Map<string, number>();
  const retention = new Map<string, Fiber.Fiber<void>>();
  const changes = makeFanout<SetupChange>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const modify = (
    threadId: string,
    mutate: (snapshot: WorktreeSetupSnapshot) => WorktreeSetupSnapshot,
  ) =>
    Effect.suspend(() => {
      const tracked = setups.get(threadId);
      if (tracked === undefined) return Effect.void;
      const sequence = tracked.snapshot.sequence + 1;
      tracked.snapshot = { ...mutate(tracked.snapshot), sequence };
      lastSequence.set(threadId, sequence);
      return changes.publish([{ threadId, snapshot: tracked.snapshot }]);
    });

  const clearRetention = (threadId: string) =>
    Effect.suspend(() => {
      const fiber = retention.get(threadId);
      retention.delete(threadId);
      return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
    });

  const begin: WorktreeSetups["begin"] = (input) =>
    Effect.gen(function* () {
      yield* clearRetention(input.threadId);
      const snapshot: WorktreeSetupSnapshot = {
        threadId: ThreadId.make(input.threadId),
        phase: "running",
        startedAt: yield* nowIso,
        endedAt: null,
        branch: input.branch,
        baseRef: input.baseRef,
        worktreePath: null,
        setupScript: null,
        stages: WORKTREE_SETUP_STAGE_ORDER.filter((id) => input.stages.includes(id)).map(
          emptyStage,
        ),
        error: null,
        sequence: (lastSequence.get(input.threadId) ?? -1) + 1,
      };
      lastSequence.set(input.threadId, snapshot.sequence);
      setups.set(input.threadId, { snapshot, fiber: null });
      yield* changes.publish([{ threadId: input.threadId, snapshot }]);
    });

  const stageStatus: WorktreeSetups["stageStatus"] = (threadId, stageId, status, detail) =>
    Effect.flatMap(nowIso, (at) =>
      modify(threadId, (snapshot) => ({
        ...snapshot,
        stages: snapshot.stages.map((stage) => {
          if (stage.id !== stageId) return stage;
          const ongoing = status === "running" || status === "pending";
          return {
            ...stage,
            status,
            startedAt: stage.startedAt ?? (status === "pending" ? null : at),
            endedAt: ongoing ? null : (stage.endedAt ?? at),
            ...(detail === undefined ? {} : { detail: clampDetail(detail) }),
          };
        }),
      })),
    );

  const appendTail: WorktreeSetups["appendTail"] = (threadId, stageId, line) =>
    modify(threadId, (snapshot) => ({
      ...snapshot,
      stages: snapshot.stages.map((stage) =>
        stage.id === stageId
          ? {
              ...stage,
              tail: [...stage.tail, clamp(line, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH)].slice(
                -TAIL_LINE_LIMIT,
              ),
            }
          : stage,
      ),
    }));

  const remove = (threadId: string) =>
    Effect.suspend(() => {
      if (!setups.delete(threadId)) return Effect.void;
      lastSequence.delete(threadId);
      return changes.publish([{ threadId, snapshot: null }]);
    });

  const finish: WorktreeSetups["finish"] = (threadId, phase, error) =>
    Effect.gen(function* () {
      const tracked = setups.get(threadId);
      if (tracked === undefined) return;
      tracked.fiber = null;
      const endedAt = yield* nowIso;
      const ended: WorktreeSetupStageStatus =
        phase === "done" ? "done" : phase === "cancelled" ? "skipped" : "failed";
      yield* modify(threadId, (snapshot) => ({
        ...snapshot,
        phase,
        endedAt,
        error:
          error === undefined || error === null
            ? null
            : clamp(error, WORKTREE_SETUP_ERROR_MAX_LENGTH),
        stages: snapshot.stages.map((stage) =>
          stage.status === "running" ? { ...stage, status: ended, endedAt } : stage,
        ),
      }));
      yield* clearRetention(threadId);
      const kept = yield* Effect.sleep(FINISHED_RETENTION).pipe(
        Effect.andThen(remove(threadId)),
        Effect.forkIn(scope),
      );
      retention.set(threadId, kept);
    });

  const cancellable: WorktreeSetups["cancellable"] = (threadId, fiber) =>
    Effect.sync(() => {
      const tracked = setups.get(threadId);
      if (tracked !== undefined) tracked.fiber = fiber;
    });

  const cancel: WorktreeSetups["cancel"] = (threadId) =>
    Effect.suspend(() => {
      const tracked = setups.get(threadId);
      if (tracked === undefined || tracked.snapshot.phase !== "running" || tracked.fiber === null) {
        return Effect.succeed(false);
      }
      return Effect.as(Fiber.interrupt(tracked.fiber), true);
    });

  const stream: WorktreeSetups["stream"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed first: what changes between the read and the subscription is in neither.
        const live = yield* changes.subscribe((change) => change.threadId === threadId);
        const initial = setups.get(threadId)?.snapshot ?? null;
        let last = initial?.sequence ?? -1;
        return Stream.make(initial).pipe(
          Stream.concat(
            live.pipe(
              Stream.filter((change) => {
                if (change.snapshot !== null && change.snapshot.sequence <= last) return false;
                last = change.snapshot?.sequence ?? -1;
                return true;
              }),
              Stream.map((change) => change.snapshot),
            ),
          ),
        );
      }),
    );

  return {
    begin,
    update: modify,
    stageStatus,
    appendTail,
    finish,
    cancellable,
    cancel,
    stream,
  };
};

// ─── Preparing a worktree ────────────────────────────────────────────────────

/** A launched session's new worktree being prepared, and the opening message it holds. */
export interface Preparation {
  readonly session: BearerSession;
  /** The thread as t3code knows it, which the setup card is keyed by. */
  readonly threadId: string;
  readonly sessionId: string;
  readonly projectId: string;
  /** The opening message's run, or null for a launch with no message. */
  readonly runId: string | null;
  readonly options: ThreadLaunchOptions;
}

/** What a preparation needs of the person's hub. */
export interface PreparationHost {
  readonly mend: GatedMend;
  readonly terminals: Terminals;
  readonly setups: WorktreeSetups;
  /** The session's worktree, and its path as the thread shows it; null once it is gone. */
  readonly worktreeOf: (
    sessionId: string,
  ) => Effect.Effect<{ readonly worktreeId: string; readonly worktreePath: string } | null>;
  /** Mend's 422 to a launch read again: the session's `updatedAt` when it is under way. */
  readonly launchUnderWay: (token: string, sessionId: string) => Effect.Effect<string | null>;
  /** Reads the session's project again, so the queue sees its agent. */
  readonly refresh: (projectId: string) => Effect.Effect<void>;
  /** The opening message's wait ends: it takes its turn (null), or fails as a preparation. */
  readonly settle: (preparation: Preparation, failure: string | null) => Effect.Effect<void>;
}

/**
 * How a setup script's shell waits for Mend to start the session's workspace: once a second, for
 * as long as the queue waits for a launch (`DEFAULT_QUEUE_TIMINGS.launchDeadlineMs`).
 */
const SETUP_SHELL_RETRY = "1 second";
const SETUP_SHELL_ATTEMPTS = 600;
/** Wide enough that the shell does not wrap the typed script, which would hide its echo. */
const SETUP_TERMINAL_COLUMNS = 400;
const SETUP_TERMINAL_ROWS = 40;

/**
 * Prepares a launched session's new worktree as t3code does after its checkout: the t3.json setup
 * script runs in a Mend shell beside the agent, its output on the setup card, and the opening
 * message goes once the script has started, or exited for a script marked `async: false`. A
 * failure fails the opening message as t3code's `workspace_preparation_failed`, which its retry
 * takes; a cancel stops the setup's shell.
 */
export const prepareWorktree = (host: PreparationHost, preparation: Preparation) => {
  const { mend, terminals, setups } = host;
  const { session, threadId, sessionId } = preparation;
  const token = session.deviceToken;
  const failure = (reason: string) => new WorkspacePreparationFailed({ reason });
  let setupTerminal: string | null = null;

  /** The opening message may go: from here a cancel no longer undoes the setup. */
  const handOff = Effect.gen(function* () {
    yield* setups.cancellable(threadId, null);
    yield* setups.stageStatus(threadId, "agent", "running");
    yield* host.settle(preparation, null);
    yield* setups.stageStatus(threadId, "agent", "done");
  }).pipe(Effect.uninterruptible);

  const prepare = Effect.gen(function* () {
    yield* setups.cancellable(threadId, yield* Effect.fiber);
    yield* setups.stageStatus(threadId, "setup-script", "running", "Reading t3.json");
    const where = yield* host.worktreeOf(sessionId);
    if (where === null) return yield* failure("The session is not in this environment any more.");
    yield* setups.update(threadId, (snapshot) => ({
      ...snapshot,
      worktreePath: where.worktreePath,
    }));
    const contents = yield* mend
      .worktreeContents(token, where.worktreeId, { path: T3_PROJECT_FILE_NAME, at: null })
      .pipe(
        Effect.map((read) =>
          read.file === null || read.file.truncated ? null : read.file.contents,
        ),
        Effect.catchTag("MendNotFound", () => Effect.succeed(null)),
        Effect.mapError((error) =>
          failure(`Mend could not read t3.json in the worktree: ${error.message}`),
        ),
      );
    const source = setupSourceOf(contents);
    if (source._tag === "None") {
      yield* setups.stageStatus(threadId, "setup-script", "skipped", source.reason);
      yield* handOff;
      yield* setups.finish(threadId, "done");
      return;
    }
    const terminalId = setupTerminalIdOf(source.name);
    yield* setups.stageStatus(threadId, "setup-script", "running", "Starting the workspace");
    const launched = yield* mend.launchProtocol(token, sessionId, "", preparation.options).pipe(
      Effect.as(true),
      Effect.catchTag("MendCommandRefused", (error) =>
        error.status === 422
          ? Effect.map(host.launchUnderWay(token, sessionId), (underWay) => underWay !== null)
          : Effect.fail(error),
      ),
      Effect.mapError((error) =>
        failure(`Mend could not start the session's workspace: ${error.message}`),
      ),
    );
    if (!launched) return yield* failure("Mend did not start the session's workspace.");
    yield* host.refresh(preparation.projectId);
    setupTerminal = terminalId;
    yield* terminals
      .open(session, {
        threadId,
        terminalId,
        cwd: where.worktreePath,
        worktreePath: where.worktreePath,
        cols: SETUP_TERMINAL_COLUMNS,
        rows: SETUP_TERMINAL_ROWS,
      })
      .pipe(
        // Mend answers 409 until the workspace runs; the thread may not be read yet either.
        Effect.retry({
          while: (error) =>
            error._tag === "TerminalNotRunningError" || error._tag === "TerminalSessionLookupError",
          schedule: Schedule.spaced(SETUP_SHELL_RETRY),
          times: SETUP_SHELL_ATTEMPTS,
        }),
        Effect.mapError((error) =>
          failure(
            error._tag === "EnvironmentAuthorizationError"
              ? error.message
              : "Mend did not open a shell in the session's workspace for the setup script.",
          ),
        ),
      );
    yield* setups.update(threadId, (snapshot) => ({
      ...snapshot,
      setupScript: { name: source.name, command: source.command, terminalId },
    }));
    yield* setups.stageStatus(threadId, "setup-script", "running", null);
    const run = runSetupScript({
      terminals,
      threadId,
      terminalId,
      command: source.command,
      onLine: (line) => setups.appendTail(threadId, "setup-script", line),
    }).pipe(
      Effect.mapError(() =>
        failure("The gateway lost the setup script's terminal before it ended."),
      ),
    );
    const exited = (exitCode: number | null) =>
      Effect.gen(function* () {
        yield* setups.stageStatus(
          threadId,
          "setup-script",
          exitCode === 0 ? "done" : "failed",
          `exited with ${exitCode ?? "no exit code"}`,
        );
        if (exitCode === 0) yield* terminals.close(session, { threadId, terminalId });
      });
    if (source.async) {
      const running = yield* Effect.forkChild(run);
      yield* handOff;
      const exitCode = yield* Fiber.join(running).pipe(
        Effect.catch((error) =>
          setups
            .stageStatus(threadId, "setup-script", "failed", error.reason)
            .pipe(Effect.as(undefined)),
        ),
      );
      if (exitCode !== undefined) yield* exited(exitCode);
      yield* setups.finish(threadId, "done");
      return;
    }
    const exitCode = yield* run;
    yield* exited(exitCode);
    if (exitCode !== 0) {
      return yield* failure(`Setup script exited with ${exitCode ?? "no exit code"}.`);
    }
    yield* handOff;
    yield* setups.finish(threadId, "done");
  });

  return prepare.pipe(
    Effect.onError((cause) =>
      Effect.gen(function* () {
        const cancelled = Cause.hasInterruptsOnly(cause);
        const error = Cause.findErrorOption(cause);
        const reason = cancelled
          ? "Worktree setup cancelled."
          : error._tag === "Some"
            ? error.value.reason
            : "The gateway could not prepare the worktree.";
        yield* setups.finish(threadId, cancelled ? "cancelled" : "failed", reason);
        if (cancelled && setupTerminal !== null) {
          yield* terminals.close(session, {
            threadId,
            terminalId: setupTerminal,
            deleteHistory: true,
          });
        }
        yield* host.settle(preparation, reason);
      }),
    ),
    Effect.ignore,
  );
};

/** Why preparing a worktree stopped, in words the thread shows. */
export class WorkspacePreparationFailed extends Schema.TaggedError<WorkspacePreparationFailed>()(
  "WorkspacePreparationFailed",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// ─── The setup script ────────────────────────────────────────────────────────

/** The script a new worktree's t3.json runs on creation, or why there is none. */
export type SetupSource =
  | {
      readonly _tag: "Script";
      readonly name: string;
      readonly command: string;
      /** False holds the opening message until the script exits (t3.json's `async`). */
      readonly async: boolean;
    }
  | { readonly _tag: "None"; readonly reason: string };

const decodeProjectFile = Schema.decodeUnknownOption(Schema.fromJsonString(T3ProjectFile));

/** The setup script t3.json's contents name; null contents is a worktree with no t3.json. */
export const setupSourceOf = (contents: string | null): SetupSource => {
  if (contents === null) return { _tag: "None", reason: "No t3.json in this worktree." };
  const file = decodeProjectFile(contents);
  if (file._tag === "None") {
    return { _tag: "None", reason: "t3.json is invalid, so it names no setup script." };
  }
  const script = file.value.scripts?.find((candidate) => candidate.runOnWorktreeCreate === true);
  if (script === undefined) return { _tag: "None", reason: "t3.json names no setup script." };
  return {
    _tag: "Script",
    name: script.name,
    command: script.command,
    async: script.async !== false,
  };
};

/** The terminal a setup script runs in, as t3code names it (`setup-<script>`). */
export const setupTerminalIdOf = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `setup-${slug.length === 0 ? "script" : slug}`;
};

/**
 * What the script runs with, as t3code's `projectScriptRuntimeEnv` gives it. A Mend workspace holds
 * the worktree alone, so both paths are the shell's own directory, the worktree; color is off, as
 * t3code turns it off for a setup no one may be watching.
 */
const SCRIPT_ENV =
  'export T3CODE_PROJECT_ROOT="$PWD" T3CODE_WORKTREE_PATH="$PWD" COLORTERM= NO_COLOR=1 FORCE_COLOR=0';

/** The line that ends a script, with a token of its own so its output cannot fake it. */
export const setupSentinelOf = (token: string): string => `__T3_SETUP_DONE__${token}:`;

/**
 * The script as typed into a POSIX shell, as t3code wraps it: in a subshell closed on its own line,
 * so a trailing comment or heredoc in the script cannot swallow the line that reports its exit.
 */
export const setupCommandLineOf = (command: string, sentinel: string): string =>
  `( ${SCRIPT_ENV}\r${command.replace(/\r?\n/g, "\r")}\r); printf '\\n${sentinel}%s\\n' "$?"\r`;

const stripTerminalControl = (text: string): string =>
  text
    .replace(
      // oxlint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
      /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
      "",
    )
    // oxlint-disable-next-line no-control-regex -- removing control characters is the point.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

export interface SetupOutput {
  /** The script's own lines, without the shell's echo of what was typed. */
  readonly lines: ReadonlyArray<string>;
  /** How the script exited, once its line arrived; undefined until then. */
  readonly exitCode: number | undefined;
}

/** Reads a terminal's output chunk by chunk into the script's lines and its exit. */
export const setupOutputReader = (sentinel: string, commandLine: string) => {
  const done = new RegExp(`${sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-?\\d+)`);
  const echoed = commandLine
    .split("\r")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  let pending = "";
  return (chunk: string): SetupOutput => {
    const parts = `${pending}${chunk}`.split(/\r\n|\r|\n/);
    pending = (parts.pop() ?? "").slice(-PARTIAL_LINE_LIMIT);
    const lines: Array<string> = [];
    let exitCode: number | undefined;
    for (const raw of parts) {
      const exited = done.exec(raw);
      if (exited !== null) {
        exitCode = Number(exited[1]);
        continue;
      }
      const line = stripTerminalControl(raw).trimEnd();
      if (
        line.length === 0 ||
        line.includes(sentinel) ||
        echoed.some((typed) => line.endsWith(typed))
      ) {
        continue;
      }
      lines.push(line.slice(0, WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH));
    }
    return { lines, exitCode };
  };
};

/**
 * Types the script into the thread's open terminal and waits for it: its exit code, or null when
 * the terminal ended first. Each line it prints goes to `onLine`.
 */
export const runSetupScript = (input: {
  readonly terminals: Terminals;
  readonly threadId: string;
  readonly terminalId: string;
  readonly command: string;
  readonly onLine: (line: string) => Effect.Effect<void>;
}): Effect.Effect<number | null, TerminalFailure | SubscriberFellBehind> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sentinel = setupSentinelOf(randomUUID().replaceAll("-", ""));
      const commandLine = setupCommandLineOf(input.command, sentinel);
      const read = setupOutputReader(sentinel, commandLine);
      const exited = yield* Deferred.make<number | null, SubscriberFellBehind>();
      // Subscribed before the script is typed, so its exit cannot pass unseen.
      const events = yield* input.terminals.observe(input.threadId, input.terminalId);
      yield* events.pipe(
        Stream.runForEach((event) => {
          if (event.type === "exited" || event.type === "closed") {
            return Deferred.succeed(exited, null);
          }
          if (event.type !== "output") return Effect.void;
          const output = read(event.data);
          return Effect.forEach(output.lines, input.onLine, { discard: true }).pipe(
            Effect.andThen(
              output.exitCode === undefined
                ? Effect.void
                : Deferred.succeed(exited, output.exitCode),
            ),
          );
        }),
        Effect.catch((error) => Deferred.fail(exited, error)),
        Effect.forkScoped,
      );
      yield* input.terminals.write({
        threadId: input.threadId,
        terminalId: input.terminalId,
        data: commandLine,
      });
      return yield* Deferred.await(exited);
    }),
  );
