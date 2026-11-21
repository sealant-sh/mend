import { Schema } from "effect";

/**
 * A session's workspace reached its memory limit and the kernel stopped a process in it
 * (SLNT-1233). Mend reads the workspace's own count of those kills (its cgroup's `oom_kill`) when
 * a turn ends and when the agent ends, and records each new one once.
 *
 * - `limitBytes`: the workspace's limit as the workspace reports it; null when it reports none
 *   (the kill was the host's, or the limit could not be read).
 * - `stopped`: `agent` when the agent itself ended with the kill, `process` when the agent went
 *   on and something else was stopped, most likely a command it ran. The kernel names the process
 *   it stopped only in the host's log, which a workspace cannot read, so this is what Mend
 *   observed, not the process's name.
 * - `agent`: the agent's name as a person reads it (`Claude Code`, `Codex`).
 */
export const MemoryLimitHit = Schema.Struct({
  limitBytes: Schema.NullOr(Schema.Int),
  stopped: Schema.Literals(["agent", "process"]),
  agent: Schema.String,
});
export type MemoryLimitHit = typeof MemoryLimitHit.Type;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** `4 GiB`, `1.5 GiB`, `512 MiB`. */
export const memorySizeWords = (bytes: number): string =>
  bytes >= GiB ? `${Number((bytes / GiB).toFixed(1))} GiB` : `${Math.round(bytes / MiB)} MiB`;

/** What the session says: what was stopped, and that the workspace hit its memory limit. */
export const memoryLimitWords = (hit: MemoryLimitHit): string => {
  const limit =
    hit.limitBytes === null
      ? "ran out of memory"
      : `reached its memory limit of ${memorySizeWords(hit.limitBytes)}`;
  const subject = `${hit.agent.charAt(0).toUpperCase()}${hit.agent.slice(1)}`;
  return hit.stopped === "agent"
    ? `The workspace ${limit}, and the kernel stopped ${hit.agent}.`
    : `The workspace ${limit}, and the kernel stopped a process in it, most likely a command ${hit.agent} ran. ${subject} is still running.`;
};
