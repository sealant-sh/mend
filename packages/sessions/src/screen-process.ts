import type {
  ScreenDisplaysFullError,
  ScreenLifeChange,
  ScreensRepo,
  SessionProcessesRepo,
} from "@mend/db";
import { SealantRunId, SealantWorkspaceId, type SessionId } from "@mend/domain";
import type {
  DisplayNumber,
  Screen,
  ScreenEndReason,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import type { PersonSessionOptions, ProcessUser, SealantPlatformError } from "@mend/sealant";
import type { InteractiveSession, Workspace, WorkspaceExecResult } from "@sealant/sdk";
import { Effect, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ScreenPasswordsHeld } from "./screen/passwords.ts";
import { type ScreenReport, screenArgv, screenReapArgv, screenReportOf } from "./screen/script.ts";

/** What the screen process needs of the engine (ADR 0020): its process primitives, no more. */
export interface ScreenProcessDeps<E> {
  readonly screens: ScreensRepo["Service"];
  readonly processes: SessionProcessesRepo["Service"];
  readonly passwords: ScreenPasswordsHeld;
  /** The session and its live workspace, refused when nothing new may start there. */
  readonly workspaceOf: (
    sessionId: SessionId,
  ) => Effect.Effect<{ readonly session: Session; readonly workspace: Workspace }, E>;
  /** The session's person in a person-layout executor (ADR 0016); null where there is none. */
  readonly startAs: (
    session: Session,
    workspace: Workspace,
  ) => Effect.Effect<
    {
      readonly user: ProcessUser;
      readonly env: Readonly<Record<string, string>>;
    } | null,
    SealantPlatformError
  >;
  readonly open: (
    workspace: Workspace,
    argv: ReadonlyArray<string>,
    options?: PersonSessionOptions,
  ) => Effect.Effect<InteractiveSession, SealantPlatformError>;
  /** Runs `argv` in `process`'s workspace as the person it runs as. */
  readonly exec: (
    process: SessionProcess,
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<WorkspaceExecResult, SealantPlatformError>;
  /** Closes a process's terminal; false when the platform would not. */
  readonly close: (workspaceId: SealantWorkspaceId, ptyId: string) => Effect.Effect<boolean>;
  readonly markExited: (process: SessionProcess, how: "exited" | "stopped") => Effect.Effect<void>;
  /** A close the platform refused: the row stays live and the session line says so. */
  readonly notStopped: (process: SessionProcess) => Effect.Effect<void>;
  /** Watches the process until it ends, outliving the caller. */
  readonly watch: (process: SessionProcess) => Effect.Effect<void>;
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
}

/** A screen runs only as its session's person (ADR 0020), so nothing else holds its passwords. */
export class ScreenNeedsPersonError extends Schema.TaggedError<ScreenNeedsPersonError>()(
  "ScreenNeedsPersonError",
  { sessionId: Schema.String, message: Schema.String },
) {}

export interface ScreenProcess<E> {
  readonly start: (
    sessionId: SessionId,
  ) => Effect.Effect<
    Screen,
    E | SealantPlatformError | ScreenDisplaysFullError | ScreenNeedsPersonError
  >;
  readonly stop: (sessionId: SessionId, reason: ScreenEndReason) => Effect.Effect<void>;
  /** A screen row ended without a stop of ours: its process exited, or its workspace ended. */
  readonly ended: (
    rows: ReadonlyArray<SessionProcess>,
    reason: ScreenEndReason,
  ) => Effect.Effect<void>;
}

/** No answer, or the platform's own failure: Xvnc may have started anyway. */
const lostAnswer = (error: SealantPlatformError) => error.status === null || error.status >= 500;

const STARTED = new Set<Screen["life"]["_tag"]>(["Starting", "Live"]);

type Live = Extract<Screen["life"], { readonly _tag: "Live" }>;

const lifeAfter = (life: Screen["life"], report: ScreenReport): Live | null => {
  if (report._tag === "Ready") {
    return life._tag === "Starting" ? { _tag: "Live", degraded: null } : null;
  }
  return STARTED.has(life._tag) ? { _tag: "Live", degraded: report.reason } : null;
};

/**
 * A session's screen as one of its processes (ADR 0020): a PTY of kind `screen` on the session's
 * display, as its person, which holds neither the session nor its workspace. Start and stop are
 * idempotent and serialized per session.
 */
export const makeScreenProcess = <E>(deps: ScreenProcessDeps<E>): ScreenProcess<E> => {
  const { screens, processes, passwords } = deps;
  const locks = new Map<SessionId, Semaphore.Semaphore>();
  const locked = <A, X>(sessionId: SessionId, effect: Effect.Effect<A, X>) => {
    const lock = locks.get(sessionId) ?? Semaphore.makeUnsafe(1);
    locks.set(sessionId, lock);
    return lock.withPermit(effect);
  };
  const live = (processId: Screen["processId"]) =>
    processId === null
      ? Effect.succeed(null)
      : Effect.map(processes.byId(processId), (row) => (row?.exitedAt === null ? row : null));
  const setLife = (screen: Screen, change: ScreenLifeChange) =>
    screens
      .setLife(screen.id, change)
      .pipe(Effect.catchTag("ScreenNotFoundError", () => Effect.void));

  /** Ends what a start with no answer left on `display`; false when the reap did not run. */
  const reaped = (row: SessionProcess, display: DisplayNumber) =>
    Effect.logWarning("screen: a start's answer was lost · reaping").pipe(
      Effect.annotateLogs({ sessionId: row.sessionId, display }),
      Effect.andThen(deps.exec(row, screenReapArgv(display))),
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  /** A row without a terminal is a start that never answered: only its display reaches it. */
  const endedRow = (row: SessionProcess, display: DisplayNumber) =>
    Effect.gen(function* () {
      const ended =
        row.sealantSessionId === null
          ? yield* reaped(row, display)
          : yield* deps.close(row.sealantWorkspaceId, row.sealantSessionId);
      if (!ended) {
        yield* deps.notStopped(row);
        return false;
      }
      yield* deps.markExited(row, "stopped");
      return true;
    });

  const follow = (screen: Screen, row: SessionProcess, pty: InteractiveSession) =>
    Stream.fromAsyncIterable(pty.output(), (cause) => cause).pipe(
      Stream.map((chunk) => chunk.data),
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        const report = screenReportOf(line);
        if (report === null) return Effect.void;
        return locked(
          screen.sessionId,
          Effect.gen(function* () {
            const now = yield* screens.byId(screen.id);
            const life = now?.processId === row.id ? lifeAfter(now.life, report) : null;
            if (now !== null && life !== null) yield* setLife(now, { life, processId: row.id });
          }),
        );
      }),
      Effect.ignore,
    );

  const start = (sessionId: SessionId) =>
    locked(
      sessionId,
      Effect.gen(function* () {
        const { session, workspace } = yield* deps.workspaceOf(sessionId);
        const screen = yield* screens.reserve({
          sessionId,
          workspaceId: SealantWorkspaceId.make(workspace.id),
        });
        const running = yield* live(screen.processId);
        const signableHere = passwords.of(sessionId) !== null;
        if (running !== null && STARTED.has(screen.life._tag) && signableHere) return screen;
        if (running !== null && !(yield* endedRow(running, screen.display))) return screen;
        const startAs = yield* deps.startAs(session, workspace);
        const runsAs = session.ownerUserId;
        if (startAs === null || runsAs === null) {
          return yield* new ScreenNeedsPersonError({
            sessionId,
            message: "this workspace cannot give a screen its own person · no screen was started",
          });
        }
        const argv = screenArgv(screen.display);
        const row = yield* processes.create({
          sessionId,
          sealantWorkspaceId: SealantWorkspaceId.make(workspace.id),
          sealantSessionId: null,
          kind: "screen",
          label: "screen",
          argv,
          status: "starting",
          runsAs,
        });
        const starting = yield* screens
          .setLife(screen.id, { life: { _tag: "Starting" }, processId: row.id })
          .pipe(Effect.orDie);
        const openWithFreshPasswords = Effect.suspend(() => {
          passwords.issue(sessionId, runsAs);
          return deps.open(workspace, argv, { user: startAs.user, env: startAs.env });
        });
        const pty = yield* openWithFreshPasswords.pipe(
          Effect.catchIf(lostAnswer, (lost) =>
            Effect.flatMap(reaped(row, screen.display), (reap) =>
              reap ? openWithFreshPasswords : Effect.fail(lost),
            ),
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              passwords.forget(sessionId);
              if (lostAnswer(error) && !(yield* reaped(row, screen.display))) {
                return yield* deps.notStopped(row);
              }
              yield* deps.markExited(row, "exited");
              yield* setLife(starting, { life: { _tag: "Ended", reason: "process-exited" } });
            }),
          ),
        );
        yield* processes.setSealantSessionId(row.id, pty.id, SealantRunId.make(pty.runId));
        yield* processes.setStatus(row.id, "running");
        yield* deps.watch({ ...row, sealantSessionId: pty.id, status: "running" });
        yield* deps.fork(follow(starting, row, pty));
        return starting;
      }),
    );

  const stop = (sessionId: SessionId, reason: ScreenEndReason) =>
    locked(
      sessionId,
      Effect.gen(function* () {
        const screen = yield* screens.ofSession(sessionId);
        if (screen === null || !STARTED.has(screen.life._tag)) return;
        const running = yield* live(screen.processId);
        if (running !== null && !(yield* endedRow(running, screen.display))) return;
        passwords.forget(sessionId);
        yield* setLife(screen, { life: { _tag: "Ended", reason } });
      }),
    );

  const ended = (rows: ReadonlyArray<SessionProcess>, reason: ScreenEndReason) =>
    Effect.forEach(
      rows.filter((row) => row.kind === "screen"),
      (row) =>
        locked(
          row.sessionId,
          Effect.gen(function* () {
            const screen = yield* screens.ofSession(row.sessionId);
            if (screen?.processId !== row.id || !STARTED.has(screen.life._tag)) return;
            passwords.forget(row.sessionId);
            yield* setLife(screen, { life: { _tag: "Ended", reason } });
          }),
        ),
      { discard: true },
    );

  return { start, stop, ended };
};
