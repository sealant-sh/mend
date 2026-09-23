import {
  agentProcessOutcome,
  type AgentTurn,
  type SessionProcess,
  type SessionStatus,
  type SlackSessionState,
} from "@mend/domain/workbench";

/**
 * The session as its Slack thread hears it (docs/adr/0006-slack.md, "What Mend posts, and where").
 *
 * Session status is a fold over every process, so it cannot say by itself what the request came
 * to. A protocol agent stays alive between turns and the session keeps reading `running` (or
 * `idle`), so the request's outcome is its latest turn's: a completed turn is `completed` and
 * carries ✅, and the next turn puts the thread back to `running`. An agent process that ended
 * speaks for itself. Nothing here is a verdict: `completed` says the turn ended as the harness
 * reported it.
 */
export const slackSessionState = (input: {
  readonly status: SessionStatus;
  readonly currentAgent: SessionProcess | null;
  readonly turns: ReadonlyArray<Pick<AgentTurn, "ordinal" | "status">>;
}): SlackSessionState => {
  switch (input.status) {
    case "starting":
    case "waiting":
    case "completed":
    case "failed":
    case "stopped":
      return input.status;
    case "running":
    case "idle": {
      if (input.turns.some((turn) => turn.status === "queued" || turn.status === "running")) {
        return "running";
      }
      const outcome = input.currentAgent === null ? null : agentProcessOutcome(input.currentAgent);
      if (outcome !== null) return outcome;
      const latest = input.turns.reduce<Pick<AgentTurn, "ordinal" | "status"> | null>(
        (last, turn) => (last === null || turn.ordinal > last.ordinal ? turn : last),
        null,
      );
      if (latest === null) return input.currentAgent === null ? "starting" : "running";
      switch (latest.status) {
        case "completed":
          return "completed";
        case "failed":
          return "failed";
        case "interrupted":
        case "cancelled":
          return "stopped";
        default:
          return "running";
      }
    }
  }
};

/**
 * Whether the status message may move from what it shows to `to`. Anything moves forward, and a
 * follow-up turn moves a settled session back to `running`, but nothing returns to `starting`: a
 * session whose launch failed still reads as not yet launched, and must keep `failed`.
 */
export const statusMayMove = (from: SlackSessionState | null, to: SlackSessionState): boolean =>
  from === null || to !== "starting" || from === "starting";

/** A state the thread reports the change beside: the turn or the session has ended. */
export const isSettledState = (state: SlackSessionState): boolean =>
  state === "completed" || state === "failed" || state === "stopped";
