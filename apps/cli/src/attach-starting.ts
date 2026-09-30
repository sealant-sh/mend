import { type AgentStartingFacts, agentStartingLine } from "@mend/domain/workbench";

/**
 * An attach to an agent that has drawn nothing yet (`agentStartingLine`): until the first output
 * bytes arrive, the attach says the agent is starting on the line the agent will draw over, and
 * erases it the moment they do. The bytes are written after the erase, so the agent's screen is
 * never touched. The attach replays the PTY from its first byte, so a reattach to an agent that
 * already drew gets its screen at once and never sees the line.
 */

/** Who is starting, in the line's words: the harness by name, a command of the owner's own as one. */
export const startingLabelOf = (harness: string): string =>
  harness === "run" ? "the command" : harness === "shell" ? "the shell" : harness;

/** Erase the current terminal line, leaving the cursor at its start. */
export const CLEAR_LINE = "\r\x1b[2K";

/** The line, drawn over the current terminal line. */
export const startingLine = (
  label: string,
  facts: AgentStartingFacts,
  elapsedMs: number,
  cancelHint: string,
): string =>
  `${CLEAR_LINE}  ${agentStartingLine(label, facts, elapsedMs)}${cancelHint === "" ? "" : ` · ${cancelHint}`}`;

export interface FirstOutputGate {
  /** Output arrived: erases the line if it was drawn. Every later call does nothing. */
  readonly pass: () => void;
  /** The attach ends: stops the timers and erases the line if it is still drawn. */
  readonly stop: () => void;
  /** Newer facts (the session's detail answered): the line uses them from now on. */
  readonly update: (facts: AgentStartingFacts) => void;
  /** Whether the line is on screen now. */
  readonly shown: () => boolean;
}

/**
 * Draw the starting line after `graceMs` without output, then once a second, until `pass` or
 * `stop`. The grace keeps a reattach, whose replay arrives at once, from flashing the line.
 */
export const firstOutputGate = (options: {
  readonly label: string;
  readonly write: (text: string) => void;
  readonly now: () => number;
  readonly cancelHint: string;
  readonly graceMs?: number;
  readonly intervalMs?: number;
}): FirstOutputGate => {
  const attachedAt = options.now();
  let facts: AgentStartingFacts = { startedAt: null, freshMachine: false };
  let shown = false;
  let done = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const draw = () => {
    if (done) return;
    shown = true;
    const since = facts.startedAt ?? attachedAt;
    options.write(startingLine(options.label, facts, options.now() - since, options.cancelHint));
  };
  const grace = setTimeout(() => {
    draw();
    interval = setInterval(draw, options.intervalMs ?? 1000);
  }, options.graceMs ?? 400);
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(grace);
    if (interval !== null) clearInterval(interval);
    if (shown) options.write(CLEAR_LINE);
    shown = false;
  };
  return {
    pass: finish,
    stop: finish,
    update: (next) => {
      facts = next;
      if (shown) draw();
    },
    shown: () => shown,
  };
};
