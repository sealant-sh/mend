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
  ]),
  /** The harness's own id: what ending it names. */
  id: Schema.String,
  description: Schema.NullOr(Schema.String),
  /**
   * The person the process runs as, or the session's owner, can end it from the waiting line
   * (Claude's task stop, Codex's terminal terminate and goal clear). A wakeup or a monitor ends on
   * its own (at most an hour, at most 30 minutes).
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
};

const ORDER: ReadonlyArray<ConversationWaitWork["kind"]> = [
  "task",
  "paused-task",
  "sub-agent",
  "terminal",
  "goal",
  "monitor",
  "wakeup",
  "cron",
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
    parts.push(kind === "goal" && count === 1 ? "a goal" : `${count} ${count === 1 ? one : many}`);
  }
  const waited = parts.length === 0 ? "agent" : listed(parts);
  return `Waits for ${input.runsAs}'s ${waited} to finish before ${input.sender}'s turn starts.`;
};

/** Why another person's turn is not sent to an opencode session (decision 6). */
export const OPENCODE_NOT_STEERABLE =
  "opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.";
