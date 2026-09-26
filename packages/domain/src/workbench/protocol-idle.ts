import { OPEN_AGENT_TURN_STATUSES, type AgentRequest, type AgentTurn } from "./agent-protocol.ts";
import { currentAgentProcess, isLiveProcess } from "./session-fold.ts";
import type { SessionProcess } from "./session-process.ts";

/**
 * The idle stop (docs/SELF-HOSTING.md, "Idle agents"): a protocol agent stays up
 * between turns, waiting for the next one, and its workspace with it. Mend stops one that has sat
 * idle this many minutes, the way the Stop button does; the next message resumes it. 0 turns the
 * stop off. MEND_PROTOCOL_IDLE_STOP_MINUTES overrides it.
 */
export const DEFAULT_PROTOCOL_IDLE_STOP_MINUTES = 15;

/** What the idle reading of one unsettled session reads. */
export interface ProtocolIdleFacts {
  readonly session: { readonly settledAt: Date | null; readonly updatedAt: Date };
  readonly processes: ReadonlyArray<SessionProcess>;
  readonly turns: ReadonlyArray<Pick<AgentTurn, "status" | "createdAt" | "startedAt" | "endedAt">>;
  readonly requests: ReadonlyArray<Pick<AgentRequest, "status" | "createdAt" | "decidedAt">>;
  /** Services holding the workspace: a live attempt or an open forward (`liveCountsForSessions`). */
  readonly liveServices: number;
}

/** What holds a live protocol agent up while it is not idle. */
export type ProtocolIdleHold = "turn" | "request" | "services" | "shell";

/**
 * - `not-protocol`: settled, or the session's agent is not a live protocol process; nothing here
 *   stops it.
 * - `held`: a turn is in flight, a question or approval waits, or Services or a shell hold the
 *   workspace, which someone is using.
 * - `idle`: none of those, since `since` — the latest activity seen.
 */
export type ProtocolIdleReading =
  | { readonly kind: "not-protocol" }
  | { readonly kind: "held"; readonly by: ProtocolIdleHold }
  | { readonly kind: "idle"; readonly since: Date };

const latest = (dates: ReadonlyArray<Date | null>): Date | null =>
  dates.reduce<Date | null>(
    (last, date) => (date !== null && (last === null || date > last) ? date : last),
    null,
  );

/**
 * Whether a session's protocol agent is idle, and since when. The clock is the latest of: a turn
 * queued, started or ended; a request opened or decided; a process started, changed or ended. The
 * session's own `updatedAt` stands in only when none of those exist.
 */
export const protocolIdleReading = (facts: ProtocolIdleFacts): ProtocolIdleReading => {
  if (facts.session.settledAt !== null) return { kind: "not-protocol" };
  const agent = currentAgentProcess(facts.processes);
  if (agent === null || agent.kind !== "agent-protocol" || !isLiveProcess(agent)) {
    return { kind: "not-protocol" };
  }
  if (facts.turns.some((turn) => OPEN_AGENT_TURN_STATUSES.has(turn.status))) {
    return { kind: "held", by: "turn" };
  }
  if (facts.requests.some((request) => request.status === "pending")) {
    return { kind: "held", by: "request" };
  }
  if (facts.liveServices > 0) return { kind: "held", by: "services" };
  if (facts.processes.some((process) => process.kind === "shell" && isLiveProcess(process))) {
    return { kind: "held", by: "shell" };
  }
  const since = latest([
    ...facts.turns.flatMap((turn) => [turn.createdAt, turn.startedAt, turn.endedAt]),
    ...facts.requests.flatMap((request) => [request.createdAt, request.decidedAt]),
    ...facts.processes.flatMap((process) => [
      process.createdAt,
      process.updatedAt,
      process.exitedAt,
    ]),
  ]);
  return { kind: "idle", since: since ?? facts.session.updatedAt };
};

/** Whether an idle reading is due its stop at `nowMs`. `minutes` 0 (or less) never is. */
export const protocolIdleStopDue = (
  reading: ProtocolIdleReading,
  nowMs: number,
  minutes: number,
): boolean =>
  minutes > 0 && reading.kind === "idle" && nowMs - reading.since.getTime() >= minutes * 60_000;

/** The summary an idle-stopped session reads, and its Slack thread's status: what happened, and how to go on. */
export const idleStopSummary = (minutes: number): string =>
  `idle · stopped after ${minutes} min · reply to resume`;
