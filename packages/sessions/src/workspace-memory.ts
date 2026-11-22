/**
 * A workspace's own word on its memory (SLNT-1233): its memory limit and how many processes the
 * kernel has stopped in it for reaching that limit. A Docker or Kubernetes workspace is its own
 * cgroup, which it sees at `/sys/fs/cgroup`; the kill count only grows while the workspace runs.
 *
 * Read with a plain exec when a turn ends and when the agent ends (`engine.ts`). A workspace that
 * is not a cgroup of its own (a Boat VM, a host process) prints nothing this reads, and Mend says
 * nothing.
 */

/** cgroup v2 first (`memory.max`, `memory.events`), then v1 (`memory.limit_in_bytes`, `oom_control`). */
export const WORKSPACE_MEMORY_SCRIPT = [
  "if [ -r /sys/fs/cgroup/memory.events ]; then",
  '  printf "limit %s\\n" "$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"',
  "  grep '^oom_kill ' /sys/fs/cgroup/memory.events",
  "elif [ -r /sys/fs/cgroup/memory/memory.oom_control ]; then",
  '  printf "limit %s\\n" "$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"',
  "  grep '^oom_kill ' /sys/fs/cgroup/memory/memory.oom_control",
  "fi",
].join("\n");

/**
 * cgroup v1 writes "no limit" as the largest page-aligned 64-bit number; anything at or above a
 * pebibyte is read as none.
 */
const NO_LIMIT_FROM = 2 ** 50;

export interface WorkspaceMemoryReading {
  /** The workspace's memory limit in bytes; null when it has none. */
  readonly limitBytes: number | null;
  /** How many processes the kernel has stopped in it for reaching its limit. */
  readonly kills: number;
}

/** The script's output, or null when the workspace said nothing this reads. */
export const parseWorkspaceMemory = (stdout: string): WorkspaceMemoryReading | null => {
  let limitBytes: number | null = null;
  let kills: number | null = null;
  for (const line of stdout.split("\n")) {
    const [key, value = ""] = line.trim().split(/\s+/, 2);
    if (key === "limit" && /^\d+$/.test(value)) {
      const bytes = Number(value);
      limitBytes = Number.isSafeInteger(bytes) && bytes < NO_LIMIT_FROM ? bytes : null;
    }
    if (key === "oom_kill" && /^\d+$/.test(value)) kills = Number(value);
  }
  return kills === null ? null : { limitBytes, kills };
};

/** The agent's name as a person reads it, from the session process's harness. */
export const agentNameOf = (harness: string | null): string => {
  switch (harness) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "pi";
    case "antigravity":
      return "Antigravity";
    default:
      return "the agent";
  }
};
