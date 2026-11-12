import type { SessionProcessId } from "@mend/domain";
import type { Session, SessionProcess } from "@mend/domain/workbench";
import { asSealantUser, type SealantClient } from "@mend/sealant";
import { Effect } from "effect";

/** When a session's terminals last printed, as one worker has seen it. */
export interface TerminalOutput {
  /** The platform did not say whether one of the terminals printed. */
  readonly unread: boolean;
  /** The latest output seen; null when no terminal was read. */
  readonly changedAt: Date | null;
}

/** Where to look for a terminal's next output, and when it last printed. */
interface OutputMark {
  readonly cursor: bigint;
  readonly changedAt: Date;
}

/**
 * Terminal output as the idle stops read it on Boat. Each minute's pass asks the platform for the
 * terminal's recorded output from a cursor (`sessionOutput`, one chunk): Core answers only the PTY's
 * own output for that session, so a silent terminal answers none. A chunk is output at that pass,
 * and the cursor then moves past everything the run has recorded so far. The run's high-water mark
 * (`outputHighWater`) only places the cursor: it is every telemetry sequence of the run and rises
 * on a silent terminal. A terminal first seen counts as printing then, so a restarted worker waits
 * the full minutes again.
 */
export const makeTerminalOutput = (sealant: SealantClient["Service"], label: string) => {
  const marks = new Map<SessionProcessId, OutputMark>();

  /** Past everything the run has recorded: the next output's sequence is at least this. */
  const cursorAfterNow = (terminal: SessionProcess, platformSessionId: string) =>
    Effect.gen(function* () {
      const workspace = yield* sealant.getWorkspace(terminal.sealantWorkspaceId);
      const pty = yield* sealant.getSession(workspace, platformSessionId);
      const status = yield* Effect.tryPromise(() => pty.status());
      return status.outputHighWater + 1n;
    });

  /** The terminal's mark after this pass; null when the platform did not answer. */
  const markOf = (session: Session, terminal: SessionProcess, now: Date) =>
    Effect.gen(function* () {
      const platformSessionId = terminal.sealantSessionId;
      if (platformSessionId === null) return "no-pty" as const;
      const last = marks.get(terminal.id);
      if (last === undefined) {
        return { cursor: yield* cursorAfterNow(terminal, platformSessionId), changedAt: now };
      }
      const page = yield* sealant.sessionOutput(platformSessionId, {
        from: last.cursor.toString(),
        limit: "1",
      });
      if (page.chunks.length === 0) return last;
      return { cursor: yield* cursorAfterNow(terminal, platformSessionId), changedAt: now };
    }).pipe(
      asSealantUser(session.ownerUserId),
      Effect.catchCause((cause) =>
        Effect.logInfo(`${label}: a terminal's output was not read`).pipe(
          Effect.annotateLogs({
            sessionId: session.id,
            processId: terminal.id,
            cause: String(cause),
          }),
          Effect.as(null),
        ),
      ),
    );

  const outputOf = Effect.fn("TerminalOutput.outputOf")(function* (
    session: Session,
    terminals: ReadonlyArray<SessionProcess>,
    now: Date,
  ) {
    let unread = false;
    let changedAt: Date | null = null;
    for (const terminal of terminals) {
      const mark = yield* markOf(session, terminal, now);
      // A process with no platform PTY prints nowhere a person sees: it has no output to read.
      if (mark === "no-pty") continue;
      if (mark === null) {
        unread = true;
        continue;
      }
      marks.set(terminal.id, mark);
      if (changedAt === null || mark.changedAt > changedAt) changedAt = mark.changedAt;
    }
    return { unread, changedAt } satisfies TerminalOutput;
  });

  /** Drop the marks of terminals no longer read. */
  const keepOnly = (read: ReadonlySet<SessionProcessId>) => {
    for (const id of marks.keys()) if (!read.has(id)) marks.delete(id);
  };

  return { outputOf, keepOnly };
};
