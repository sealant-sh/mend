import type { SessionProcessId } from "@mend/domain";
import type { Session, SessionProcess } from "@mend/domain/workbench";
import { asSealantUser, type SealantClient } from "@mend/sealant";
import { Effect } from "effect";

/** When a session's terminals last printed, as one worker has seen it. */
export interface TerminalOutput {
  /** The platform did not say how much one of the terminals printed. */
  readonly unread: boolean;
  /** The latest output seen; null when no terminal was read. */
  readonly changedAt: Date | null;
}

/** The last output mark seen on one terminal, and when it last moved. */
interface OutputMark {
  readonly highWater: bigint;
  readonly changedAt: Date;
}

/**
 * Terminal output as the idle stops read it on Boat: each minute's pass asks the platform how much
 * each terminal has printed (`outputHighWater`), and a mark that moved is output at that pass. A
 * terminal first seen counts as printing then, so a restarted worker waits the full minutes again.
 */
export const makeTerminalOutput = (sealant: SealantClient["Service"], label: string) => {
  const marks = new Map<SessionProcessId, OutputMark>();

  /** How much one terminal has printed, as the platform says; null when it did not answer. */
  const highWaterOf = (session: Session, terminal: SessionProcess) =>
    Effect.gen(function* () {
      if (terminal.sealantSessionId === null) return null;
      const workspace = yield* sealant.getWorkspace(terminal.sealantWorkspaceId);
      const pty = yield* sealant.getSession(workspace, terminal.sealantSessionId);
      const status = yield* Effect.tryPromise(() => pty.status());
      return status.outputHighWater;
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
      const highWater = yield* highWaterOf(session, terminal);
      if (highWater === null) {
        unread = true;
        continue;
      }
      const last = marks.get(terminal.id);
      const mark =
        last === undefined || last.highWater !== highWater ? { highWater, changedAt: now } : last;
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
