import { Schema } from "effect";

import { AgentTurnId, SessionId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * Shared steering (docs/adr/0016-per-person-harness-homes.md, decision 6): one shared
 * conversation, each turn run by a process of its sender's own user on their own login. When the
 * next queued turn's sender is not the person the conversation's process runs as, the turn waits
 * for that process's own work, and nothing is killed. What it waits for is the waiting line,
 * which both people see wherever the turn shows.
 */

/** One piece of the previous sender's work a waiting turn waits for. */
export const ConversationWaitWork = Schema.Struct({
  kind: Schema.Literals([
    "task",
    "paused-task",
    "sub-agent",
    "terminal",
    "goal",
    "wakeup",
    "monitor",
    "cron",
    "unknown",
  ]),
  /** The harness's own id: what ending it names. */
  id: Schema.String,
  description: Schema.NullOr(Schema.String),
  /**
   * The person the process runs as, or the session's owner, can end it from the waiting line
   * (Claude's task stop, a monitor's included, Codex's terminal terminate and goal clear). A
   * wakeup ends on its own within an hour; a scheduled prompt and what the harness would not say
   * are waited for at most `CONVERSATION_WAIT_BOUNDS_MS`.
   */
  endable: Schema.Boolean,
});
export type ConversationWaitWork = typeof ConversationWaitWork.Type;

/** A turn waiting for the conversation's process to finish its own work. */
export class ConversationWait extends Schema.Class<ConversationWait>("ConversationWait")({
  sessionId: SessionId,
  /** The turn that waits; the turns behind it wait with it. */
  turnId: AgentTurnId,
  /** Whose process finishes its work: the person it runs as. */
  runsAs: Schema.NullOr(Schema.String),
  /** Whose turn waits. */
  sender: Schema.String,
  /** A turn still runs in the process. */
  openTurn: Schema.Boolean,
  work: Schema.Array(ConversationWaitWork),
  /** The waiting line, in words: "Waits for Alice's 2 background tasks … before Bob's turn starts." */
  line: Schema.String,
  since: Timestamp,
}) {}

const NOUNS: Readonly<Record<ConversationWaitWork["kind"], readonly [string, string]>> = {
  task: ["background task", "background tasks"],
  "paused-task": ["paused task", "paused tasks"],
  "sub-agent": ["sub-agent", "sub-agents"],
  terminal: ["background terminal", "background terminals"],
  goal: ["goal", "goals"],
  wakeup: ["wakeup", "wakeups"],
  monitor: ["monitor", "monitors"],
  cron: ["scheduled prompt", "scheduled prompts"],
  unknown: ["unreported work", "unreported work"],
};

/**
 * How long a waiting turn waits for a session's scheduled prompt (it lives up to seven days, and
 * nothing in the waiting line can end it): after this the hand-over goes on, the scheduled prompts
 * end with the agent, and the session line says so (review of mend#572, P3-2; review 2, P3-4).
 */
export const CONVERSATION_WAIT_BOUNDS_MS: Readonly<
  Partial<Record<ConversationWaitWork["kind"], number>>
> = {
  cron: 10 * 60_000,
};

/**
 * How long a waiting turn waits for an agent that will not say what it runs (a Codex refusing
 * `thread/backgroundTerminals/list`). It never times out into a stop: after this the waiting turn
 * fails with `UNREPORTED_WORK_REFUSAL` and the agent goes on (review 2 of mend#572, P2-1).
 */
export const CONVERSATION_UNREPORTED_WAIT_MS = 60_000;

/** Why a waiting turn was not started when the agent never said what it runs. */
export const UNREPORTED_WORK_REFUSAL =
  "The agent did not say whether its background work has finished, so this turn was not started and nothing was stopped. The person whose agent it is can end that work, or restart the session.";

/**
 * Why another person's turn is not sent to an agent started before shared steering (a Codex
 * initialized without the capability that reports background work): it takes its owner's turns
 * only until it ends or restarts (review 2 of mend#572, P2-1).
 */
export const STARTED_BEFORE_STEERING =
  "This agent was started before shared steering, so it takes only its owner's turns until it ends or restarts.";

const boundWords = (ms: number): string =>
  ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
    : `${Math.round(ms / 1000)} seconds`;

const ORDER: ReadonlyArray<ConversationWaitWork["kind"]> = [
  "task",
  "paused-task",
  "sub-agent",
  "terminal",
  "goal",
  "monitor",
  "wakeup",
  "cron",
  "unknown",
];

/** "a, b and c". */
const listed = (parts: ReadonlyArray<string>): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;

/**
 * The waiting line (decision 6): "Waits for Alice's 2 background tasks, 1 sub-agent and a goal to
 * finish before Bob's turn starts." A goal is one per conversation ("a goal"); a running turn is
 * "Alice's turn". With nothing left but the settle, it waits for the agent.
 */
export const conversationWaitLine = (input: {
  /** Whose process finishes: their name. */
  readonly runsAs: string;
  /** Whose turn waits: their name. */
  readonly sender: string;
  readonly openTurn: boolean;
  readonly work: ReadonlyArray<Pick<ConversationWaitWork, "kind">>;
}): string => {
  const parts: Array<string> = [];
  if (input.openTurn) parts.push("turn");
  for (const kind of ORDER) {
    const count = input.work.filter((work) => work.kind === kind).length;
    if (count === 0) continue;
    const [one, many] = NOUNS[kind];
    parts.push(
      kind === "goal" && count === 1
        ? "a goal"
        : kind === "unknown"
          ? one
          : `${count} ${count === 1 ? one : many}`,
    );
  }
  const waited = parts.length === 0 ? "agent" : listed(parts);
  const after: Array<string> = [];
  const cronBound = CONVERSATION_WAIT_BOUNDS_MS.cron;
  if (cronBound !== undefined && input.work.some((work) => work.kind === "cron")) {
    after.push(
      `It waits at most ${boundWords(cronBound)} for scheduled prompts, which then end with ${input.runsAs}'s agent.`,
    );
  }
  if (input.work.some((work) => work.kind === "unknown")) {
    after.push(
      `If ${input.runsAs}'s agent has still not said what it runs after ${boundWords(CONVERSATION_UNREPORTED_WAIT_MS)}, ${input.sender}'s turn is not started.`,
    );
  }
  return [
    `Waits for ${input.runsAs}'s ${waited} to finish before ${input.sender}'s turn starts.`,
    ...after,
  ].join(" ");
};

/** Why another person's turn is not sent to an opencode session (decision 6). */
export const OPENCODE_NOT_STEERABLE =
  "opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.";
