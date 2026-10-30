import type {
  ScreenDisplaysFullError,
  ScreenLifeChange,
  ScreensRepo,
  SessionProcessesRepo,
} from "@mend/db";
import { type ScreenId, SealantRunId, SealantWorkspaceId, type SessionId } from "@mend/domain";
import type {
  DisplayNumber,
  Screen,
  ScreenEndReason,
  Session,
  SessionProcess,
} from "@mend/domain/workbench";
import type { PersonSessionOptions, ProcessUser, SealantPlatformError } from "@mend/sealant";
import type { InteractiveSession, Workspace, WorkspaceExecResult } from "@sealant/sdk";
import { Effect, Option, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ScreenPasswordsHeld } from "./screen/passwords.ts";
import {
  SCREEN_REKEYED,
  type ScreenReport,
  screenArgv,
  screenDirOfArgv,
  screenReapArgv,
  screenRekeyArgv,
  screenReportOf,
} from "./screen/script.ts";

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
  /**
   * A running screen this process holds no passwords for, as after Mend restarted: its person
   * writes fresh ones over the old, so it keeps running. False when it could not be signed for.
   */
  readonly rekey: (sessionId: SessionId) => Effect.Effect<boolean>;
  /**
   * The session ended: its screen stops and the reservation `screenId` gives its display back. A
   * screen whose process would not end keeps it, so a later release (or the next boot) gives it
   * back. A reservation the session holds now that is not `screenId` is not the one that ended.
   */
  readonly release: (sessionId: SessionId, screenId: ScreenId) => Effect.Effect<void>;
  /** A screen row ended without a stop of ours: its process exited, or its workspace ended. */
  readonly ended: (
    rows: ReadonlyArray<SessionProcess>,
    reason: ScreenEndReason,
  ) => Effect.Effect<void>;
}

/** No answer, or the platform's own failure: Xvnc may have started anyway. */
const lostAnswer = (error: SealantPlatformError) => error.status === null || error.status >= 500;

const STARTED = new Set<Screen["life"]["_tag"]>(["Starting", "Live"]);

const REKEYED_WITHIN = "15 seconds";

type Live = Extract<Screen["life"], { readonly _tag: "Live" }>;

const lifeAfter = (life: Screen["life"], report: ScreenReport): Live | null => {
  if (!STARTED.has(life._tag)) return null;
  const live: Live =
    life._tag === "Live" ? life : { _tag: "Live", degraded: null, browserSandboxOff: false };
  switch (report._tag) {
    case "Ready":
      return life._tag === "Starting" ? live : null;
    case "Degraded":
      return { ...live, degraded: report.reason };
    case "BrowserSandboxOff":
      return { ...live, browserSandboxOff: true };
  }
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
        const argv = screenArgv(screen.display, startAs.user);
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

  /** Ends the session's screen; false when its process would not end and still holds the display. */
  const stopped = (sessionId: SessionId, reason: ScreenEndReason) =>
    Effect.gen(function* () {
      const screen = yield* screens.ofSession(sessionId);
      if (screen === null || !STARTED.has(screen.life._tag)) return true;
      const running = yield* live(screen.processId);
      if (running !== null && !(yield* endedRow(running, screen.display))) return false;
      passwords.forget(sessionId);
      yield* setLife(screen, { life: { _tag: "Ended", reason } });
      return true;
    });

  const stop = (sessionId: SessionId, reason: ScreenEndReason) =>
    locked(sessionId, Effect.asVoid(stopped(sessionId, reason)));

  const rekey = (sessionId: SessionId) =>
    locked(
      sessionId,
      Effect.gen(function* () {
        if (passwords.of(sessionId) !== null) return true;
        const screen = yield* screens.ofSession(sessionId);
        const running = screen?.life._tag === "Live" ? yield* live(screen.processId) : null;
        const dir = running === null ? null : screenDirOfArgv(running.argv);
        if (running === null || running.runsAs === null || dir === null) return false;
        const { session, workspace } = yield* deps.workspaceOf(sessionId);
        const startAs = yield* deps.startAs(session, workspace);
        if (startAs === null) return false;
        passwords.issue(sessionId, running.runsAs);
        const pty = yield* deps.open(workspace, screenRekeyArgv(dir), {
          user: startAs.user,
          env: startAs.env,
        });
        const said = yield* Stream.fromAsyncIterable(pty.output(), (cause) => cause).pipe(
          Stream.map((chunk) => chunk.data),
          Stream.decodeText,
          Stream.splitLines,
          Stream.filter((line) => line.trim() === SCREEN_REKEYED),
          Stream.runHead,
          Effect.timeoutOption(REKEYED_WITHIN),
          Effect.map((line) => Option.isSome(Option.flatten(line))),
        );
        if (!said) {
          passwords.forget(sessionId);
          yield* deps.close(SealantWorkspaceId.make(workspace.id), pty.id);
        }
        return said;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("screen: not signed for again").pipe(
            Effect.annotateLogs({ sessionId, cause: String(error) }),
            Effect.andThen(Effect.sync(() => passwords.forget(sessionId))),
            Effect.as(false),
          ),
        ),
      ),
    );

  const release = (sessionId: SessionId, screenId: ScreenId) =>
    locked(
      sessionId,
      Effect.gen(function* () {
        if ((yield* screens.ofSession(sessionId))?.id !== screenId) return;
        if (yield* stopped(sessionId, "session-stopped")) yield* screens.release(screenId);
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

  return { start, stop, rekey, release, ended };
};
