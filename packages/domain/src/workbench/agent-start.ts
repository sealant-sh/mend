import { PROMPTABLE_HARNESSES } from "./harness-launch.ts";

/**
 * An agent that has started and drawn nothing yet. On a fresh executor its first screen can take
 * most of a minute (alpha 2026-09-30, fda7180d: the machine was ready in ~13 s and the harness
 * started at once, but node and the harness's own files are read from a lazily fetched disk for
 * the first time, and the harness makes its startup network calls). Every surface says so instead
 * of showing a blank terminal: the session line (`agentStartingWords`, set by the engine until
 * the process's record carries output) and every attach until its first bytes
 * (`agentStartingLine`). An attach replays the PTY from its first byte, so an attach with no bytes
 * yet is an agent that has not drawn.
 */

/**
 * What the session line says between the agent's start and its first output. Null for anything
 * that is not a coding-agent TUI (a shell, a command of the owner's own): those draw at once or
 * never, and nothing about them is "starting".
 */
export const agentStartingWords = (harness: string, freshMachine: boolean): string | null =>
  PROMPTABLE_HARNESSES.has(harness)
    ? `${harness} is starting${freshMachine ? " on the new machine" : ""}`
    : null;

/** The starting words as one ` · `-part of a session line. */
const STARTING_PART = /^[a-z][a-z0-9-]* is starting(?: on the new machine)?$/u;

/**
 * A session line without the agent's starting words (`agentStartingWords`); null when they were
 * all it said. Every other part stays, in order.
 */
export const withoutAgentStarting = (summary: string | null): string | null => {
  if (summary === null) return null;
  const parts = summary.split(" · ");
  const kept = parts.filter((part) => !STARTING_PART.test(part));
  if (kept.length === parts.length) return summary;
  return kept.length === 0 ? null : kept.join(" · ");
};

/** What an attach says while the agent has drawn nothing: `claude is starting on the new machine · 23s`. */
export const agentStartingLine = (
  label: string,
  facts: AgentStartingFacts,
  elapsedMs: number,
): string =>
  `${label} is starting${facts.freshMachine ? " on the new machine" : ""} · ${Math.max(0, Math.round(elapsedMs / 1000))}s`;

/** The process rows the facts are read from; every field optional, as an older server omits some. */
export interface AgentStartingProcess {
  readonly id?: string;
  readonly sealantWorkspaceId?: string;
  readonly createdAt?: string | Date;
}

/** What an attach's starting line says beside the elapsed time. */
export interface AgentStartingFacts {
  /** When the agent process started, in the reader's clock (ms); null when unknown or untrusted. */
  readonly startedAt: number | null;
  /** Nothing else ran on the agent's executor before it: a machine made for this launch. */
  readonly freshMachine: boolean;
}

/** The longest start trusted from the server's clock: anything longer reads as skew. */
const MAX_TRUSTED_ELAPSED_MS = 60 * 60 * 1000;

const timeOf = (value: string | Date | undefined): number =>
  value === undefined
    ? Number.NaN
    : typeof value === "string"
      ? Date.parse(value)
      : value.getTime();

/**
 * The facts from a session's current agent and its processes: when the agent started, and
 * whether it was the first process on its executor. Without an agent nothing is claimed.
 */
export const agentStartingFacts = (
  currentAgent: AgentStartingProcess | null | undefined,
  processes: ReadonlyArray<AgentStartingProcess> | undefined,
  now: number,
): AgentStartingFacts => {
  if (currentAgent === null || currentAgent === undefined) {
    return { startedAt: null, freshMachine: false };
  }
  const created = timeOf(currentAgent.createdAt);
  const trusted =
    Number.isFinite(created) && created <= now && now - created <= MAX_TRUSTED_ELAPSED_MS;
  const freshMachine =
    processes !== undefined &&
    currentAgent.sealantWorkspaceId !== undefined &&
    Number.isFinite(created) &&
    !processes.some(
      (process) =>
        process.id !== currentAgent.id &&
        process.sealantWorkspaceId === currentAgent.sealantWorkspaceId &&
        timeOf(process.createdAt) < created,
    );
  return { startedAt: trusted ? created : null, freshMachine };
};
