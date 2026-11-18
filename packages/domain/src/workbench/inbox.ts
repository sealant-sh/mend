import { Schema } from "effect";

export * from "./inbox-rules.ts";

/**
 * Why a waiting session waits, as a list row says it: it asked a question, wants to run a command,
 * wants to edit a file, wants to use another tool, or needs some other decision.
 */
export const SessionAskKind = Schema.Literals(["question", "command", "edit", "tool", "decision"]);
export type SessionAskKind = typeof SessionAskKind.Type;

/** The oldest request a waiting session has open, in a few words; `subject` is cut to one line. */
export const SessionAsk = Schema.Struct({
  kind: SessionAskKind,
  /** The question, the command, the file or the tool; null when the agent named none. */
  subject: Schema.NullOr(Schema.String),
});
export type SessionAsk = typeof SessionAsk.Type;

/**
 * What a running agent is doing, as a list row says it, from its newest conversation item: running
 * a command, editing files, searching the web, using a tool, thinking, writing its reply, planning,
 * or running a background task.
 */
export const AgentActivityKind = Schema.Literals([
  "command",
  "edit",
  "search",
  "tool",
  "thinking",
  "writing",
  "planning",
  "task",
]);
export type AgentActivityKind = typeof AgentActivityKind.Type;

/** A running session's newest item, in a few words; `subject` is cut to one line. */
export const AgentActivity = Schema.Struct({
  kind: AgentActivityKind,
  /** The command, the file, the search or the tool; null when the agent named none. */
  subject: Schema.NullOr(Schema.String),
});
export type AgentActivity = typeof AgentActivity.Type;
