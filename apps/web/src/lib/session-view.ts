import { AGENTS } from "./new-session.ts";

/**
 * The agent's name as the product says it ("Claude Code", "Codex"); a harness Mend does not list
 * keeps its own name.
 */
export const harnessName = (harness: string): string =>
  AGENTS.find((agent) => agent.id === harness)?.label ?? harness;

/** "11:49": the clock time a message carries. */
export const clockTime = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
