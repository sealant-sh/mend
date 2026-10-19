import { type AgentWait, agentWaitStatus, agentWaitWords } from "./agent-wait.ts";
import {
  isAgentProcessKind,
  LIVE_PROCESS_STATUSES,
  type SessionProcess,
} from "./session-process.ts";

/**
 * Session status is a fold over live processes, never a property of one
 * process (docs/SESSION-SERVICES.md, decided 2026-08-21):
 *
 *   pending request on a live protocol agent    → `waiting`
 *   any live terminal agent asks for permission
 *   or asks a question                          → `waiting`
 *   any other live agent works                  → `running`
 *   every live agent is a terminal agent that
 *   finished its turn                           → `idle`
 *   no agent live, shells or Services live      → `idle`
 *   nothing live                                → settled (from the last agent outcome)
 *
 * The two `idle`s differ in the agent: live and finished (`agentWaitLine` says
 * `idle · claude finished its turn`), or ended.
 */
export type SessionLiveness = "waiting" | "running" | "idle" | "settled";

/** A row still counts as a workspace lease until the engine records its end. */
export const isLiveProcess = (process: SessionProcess): boolean =>
  process.exitedAt === null && LIVE_PROCESS_STATUSES.has(process.status);

export const isLiveAgentProcess = (process: SessionProcess): boolean =>
  isAgentProcessKind(process.kind) && isLiveProcess(process);

/** One live terminal agent and the wait its hooks reported. */
export interface AgentWaiting {
  readonly agent: SessionProcess;
  readonly wait: AgentWait;
}

/**
 * What a session's live agents say together, whatever order their rows come in. An ask outranks
 * work, and work outranks a finished turn: an older agent's unanswered permission still needs the
 * person after a newer one finished its turn. Among several asks, or several finished turns, the
 * earliest speaks for them.
 */
export type LiveAgentsReading =
  | { readonly _tag: "request" }
  | ({ readonly _tag: "asks" } & AgentWaiting)
  | { readonly _tag: "working" }
  | ({ readonly _tag: "finished" } & AgentWaiting)
  | { readonly _tag: "none" };

const earlier = (current: AgentWaiting | null, next: AgentWaiting): AgentWaiting => {
  if (current === null) return next;
  const order =
    current.wait.since.getTime() - next.wait.since.getTime() ||
    current.agent.createdAt.getTime() - next.agent.createdAt.getTime() ||
    current.agent.id.localeCompare(next.agent.id);
  return order <= 0 ? current : next;
};

export const liveAgentsReading = (
  processes: ReadonlyArray<SessionProcess>,
  hasPendingAgentRequest = false,
): LiveAgentsReading => {
  let protocolAgent = false;
  let working = false;
  let asks: AgentWaiting | null = null;
  let finished: AgentWaiting | null = null;
  for (const agent of processes) {
    if (!isLiveAgentProcess(agent)) continue;
    if (agent.kind === "agent-protocol") protocolAgent = true;
    const wait = agent.kind === "agent-pty" ? agent.waiting : null;
    if (wait === null) working = true;
    else if (agentWaitStatus(wait) === "waiting") asks = earlier(asks, { agent, wait });
    else finished = earlier(finished, { agent, wait });
  }
  if (protocolAgent && hasPendingAgentRequest) return { _tag: "request" };
  if (asks !== null) return { _tag: "asks", ...asks };
  if (working) return { _tag: "working" };
  if (finished !== null) return { _tag: "finished", ...finished };
  return { _tag: "none" };
};

export const foldSessionLiveness = (
  processes: ReadonlyArray<SessionProcess>,
  hasPendingAgentRequest = false,
): SessionLiveness => {
  const reading = liveAgentsReading(processes, hasPendingAgentRequest);
  switch (reading._tag) {
    case "request":
    case "asks":
      return "waiting";
    case "working":
      return "running";
    case "finished":
      return "idle";
    case "none":
      return processes.some(isLiveProcess) ? "idle" : "settled";
  }
};

const byCreatedAt = (left: SessionProcess, right: SessionProcess): number =>
  left.createdAt.getTime() - right.createdAt.getTime();

/** Every agent process of a session, oldest first. */
export const agentProcessesOf = (
  processes: ReadonlyArray<SessionProcess>,
): ReadonlyArray<SessionProcess> =>
  processes.filter((process) => isAgentProcessKind(process.kind)).toSorted(byCreatedAt);

/**
 * The agent process a session-level reader means by "the agent": the newest
 * live one, else the newest ever. Null for a session that never launched one
 * (provisioned but not started, or a pure shell bench).
 */
export const currentAgentProcess = (
  processes: ReadonlyArray<SessionProcess>,
): SessionProcess | null => {
  const agents = agentProcessesOf(processes);
  return agents.findLast(isLiveProcess) ?? agents.at(-1) ?? null;
};

/** The live terminal agents of one harness: the processes a hook report may be about. */
export const liveTerminalAgentsOf = (
  processes: ReadonlyArray<SessionProcess>,
  harness: string,
): ReadonlyArray<SessionProcess> =>
  agentProcessesOf(processes).filter(
    (process) =>
      process.kind === "agent-pty" && process.harness === harness && isLiveProcess(process),
  );

/** The line a terminal agent's wait gives the session, with the word the fold reads for it. */
export interface AgentWaitLine {
  readonly status: "waiting" | "idle";
  /** `idle · claude finished its turn`. */
  readonly line: string;
}

/** Null unless a terminal agent's wait decides the reading: work, a protocol request, no agent. */
export const agentWaitLine = (reading: LiveAgentsReading): AgentWaitLine | null => {
  if (reading._tag !== "asks" && reading._tag !== "finished") return null;
  const status = agentWaitStatus(reading.wait);
  const harness = reading.agent.harness ?? reading.agent.label ?? "the agent";
  return { status, line: `${status} · ${agentWaitWords(harness, reading.wait)}` };
};

/** What an ended agent process's exit says about the work. Null while it still runs. */
export type AgentProcessOutcome = "completed" | "failed" | "stopped";

export const agentProcessOutcome = (process: SessionProcess): AgentProcessOutcome | null => {
  if (process.exitedAt === null) return null;
  if (process.status === "stopped") return "stopped";
  // An open-workbench shell in an agent session ends when the user leaves it; its exit code
  // says nothing about the work.
  if (process.harness === "shell") return "completed";
  return process.exitCode === null || process.exitCode === 0 ? "completed" : "failed";
};

/**
 * The line a session reads once its agent is no longer live while its Services keep the workspace
 * up (docs/SESSION-SERVICES.md, "Stop"): a stop ends the agent and leaves Services running, so the
 * workspace stays up until they stop too. The agent's own outcome leads when one ran —
 * `agent stopped · 3 services keep the workspace up`. Null while the agent runs, and when no
 * Service holds the workspace.
 */
export const servicesHoldLine = (input: {
  readonly agentLive: boolean;
  readonly agentOutcome: AgentProcessOutcome | null;
  readonly liveServices: number;
}): string | null => {
  if (input.agentLive || input.liveServices <= 0) return null;
  const hold =
    input.liveServices === 1
      ? "1 service keeps the workspace up"
      : `${input.liveServices} services keep the workspace up`;
  return input.agentOutcome === null ? hold : `agent ${input.agentOutcome} · ${hold}`;
};
