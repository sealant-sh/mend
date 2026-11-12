import type { SessionRuntime } from "../settings.ts";
import { currentAgentProcess, isLiveProcess } from "./session-fold.ts";
import { isWakeShell, type SessionProcess } from "./session-process.ts";

/**
 * The terminal idle stop (docs/SELF-HOSTING.md, "Idle agents"). On Boat every session is its own
 * paid machine, so a terminal session (a shell, `mend run`, an agent in terminal mode) stops after
 * the same MEND_PROTOCOL_IDLE_STOP_MINUTES as a protocol agent once its terminals have been
 * quiet that long: nobody attached, nobody typed, nothing printed. What else runs in the
 * workspace (Docker containers, Services, background jobs) holds nothing: a shell that started
 * `docker compose up -d` and went quiet is idle. Docker sessions have no terminal idle stop.
 */

/** How often a client on a terminal stamps the session's terminal activity while it stays. */
export const TERMINAL_CLIENT_TOUCH_EVERY_MS = 60_000;

/** A session's terminals: its live PTY agents and shells. A wake shell is no terminal. */
export const terminalProcesses = (
  processes: ReadonlyArray<SessionProcess>,
): ReadonlyArray<SessionProcess> =>
  processes.filter(
    (process) =>
      isLiveProcess(process) &&
      (process.kind === "agent-pty" || (process.kind === "shell" && !isWakeShell(process))),
  );

/** What the terminal idle reading of one unsettled session reads. */
export interface TerminalIdleFacts {
  readonly session: { readonly settledAt: Date | null };
  /** The session's worktree's runtime; null on rows from before the choice (Docker). */
  readonly runtime: SessionRuntime | null;
  readonly processes: ReadonlyArray<SessionProcess>;
  /**
   * When a client last attached to, typed into, left or was still on one of the session's
   * terminals (`SessionsRepo.touchTerminal`). A client on a terminal stamps it every
   * `TERMINAL_CLIENT_TOUCH_EVERY_MS`, so an attached one always reads as recent. A client that
   * only watches counts: someone is looking at it.
   */
  readonly terminalActiveAt: Date | null;
  /**
   * When any of its terminals last printed, as far as Mend has seen it; `unread` when the platform
   * did not say how much a terminal has printed, so nothing is known about its output.
   */
  readonly output: { readonly unread: boolean; readonly changedAt: Date | null };
  /** A person holds the session's screen's input (`screenHeldByPerson`); watching holds nothing. */
  readonly screenHeld?: boolean;
  /** Capture mode: what the executor answered just now, as `ProtocolIdleFacts.capture`. */
  readonly capture?: {
    readonly pending: number;
    readonly bulkDirty: boolean | null;
    readonly overdue?: boolean;
  } | null;
}

/** What holds a quiet terminal session up. */
export type TerminalIdleHold = "output-unread" | "screen" | "capture";

/**
 * - `not-terminal`: settled, not on Boat, a protocol or external agent runs in it, or it has no
 *   live terminal; nothing here stops it.
 * - `held`: the platform did not answer how much a terminal printed, a person holds the screen's
 *   input, or the executor still ships captures.
 * - `idle`: none of those, since `since`: the latest of a terminal starting, a client on one
 *   (attached, typing, leaving), and new output. An attached client keeps `since` within a minute.
 */
export type TerminalIdleReading =
  | { readonly kind: "not-terminal" }
  | { readonly kind: "held"; readonly by: TerminalIdleHold }
  | { readonly kind: "idle"; readonly since: Date };

const latest = (dates: ReadonlyArray<Date | null>): Date | null =>
  dates.reduce<Date | null>(
    (last, date) => (date !== null && (last === null || date > last) ? date : last),
    null,
  );

/**
 * Whether a Boat session's terminals are idle, and since when. Only the three terminal signals
 * count. A process row changing, a Service running and a container up in the workspace are not
 * read at all.
 */
export const terminalIdleReading = (facts: TerminalIdleFacts): TerminalIdleReading => {
  if (facts.session.settledAt !== null || facts.runtime !== "boat") return { kind: "not-terminal" };
  const agent = currentAgentProcess(facts.processes);
  if (agent !== null && isLiveProcess(agent) && agent.kind !== "agent-pty") {
    return { kind: "not-terminal" };
  }
  const terminals = terminalProcesses(facts.processes);
  if (terminals.length === 0) return { kind: "not-terminal" };
  if (facts.output.unread) return { kind: "held", by: "output-unread" };
  if (facts.screenHeld === true) return { kind: "held", by: "screen" };
  if (
    facts.capture !== undefined &&
    facts.capture !== null &&
    (facts.capture.pending > 0 ||
      facts.capture.bulkDirty === true ||
      facts.capture.overdue === true)
  ) {
    return { kind: "held", by: "capture" };
  }
  const since = latest([
    ...terminals.map((terminal) => terminal.createdAt),
    facts.terminalActiveAt,
    facts.output.changedAt,
  ]);
  // A live terminal has a start, so `since` is never null here.
  return { kind: "idle", since: since ?? new Date(0) };
};

/** Whether a terminal idle reading is due its stop at `nowMs`. `minutes` 0 (or less) never is. */
export const terminalIdleStopDue = (
  reading: TerminalIdleReading,
  nowMs: number,
  minutes: number,
): boolean =>
  minutes > 0 && reading.kind === "idle" && nowMs - reading.since.getTime() >= minutes * 60_000;

/** The summary an idle-stopped terminal session reads: what happened, and how to go on. */
export const terminalIdleStopSummary = (minutes: number): string =>
  `idle · stopped after ${minutes} min · resume to continue`;
