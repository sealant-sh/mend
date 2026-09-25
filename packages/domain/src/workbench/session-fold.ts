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
 *   any other agent process live                → `running`
 *   no agent live, shells or Services live      → `idle`
 *   nothing live                                → settled (from the last agent outcome)
 */
export type SessionLiveness = "waiting" | "running" | "idle" | "settled";

/** A row still counts as a workspace lease until the engine records its end. */
export const isLiveProcess = (process: SessionProcess): boolean =>
  process.exitedAt === null && LIVE_PROCESS_STATUSES.has(process.status);

export const isLiveAgentProcess = (process: SessionProcess): boolean =>
  isAgentProcessKind(process.kind) && isLiveProcess(process);

export const foldSessionLiveness = (
  processes: ReadonlyArray<SessionProcess>,
  hasPendingAgentRequest = false,
): SessionLiveness => {
  let supporting = false;
  let agent = false;
  let protocolAgent = false;
  for (const process of processes) {
    if (!isLiveProcess(process)) continue;
    if (isAgentProcessKind(process.kind)) {
      agent = true;
      if (process.kind === "agent-protocol") protocolAgent = true;
    } else {
      supporting = true;
    }
  }
  if (protocolAgent && hasPendingAgentRequest) return "waiting";
  if (agent) return "running";
  return supporting ? "idle" : "settled";
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
