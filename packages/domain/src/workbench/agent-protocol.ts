import { Effect, Schema } from "effect";

import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  ChangeLandingId,
  SessionId,
  SessionProcessId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { RequestIntent, RequestIntentSource, TurnLanding } from "./landing.ts";

/** How Mend launches and records a coding-agent process. */
export const AgentLaunchMode = Schema.Literals(["pty", "protocol"]);
export type AgentLaunchMode = typeof AgentLaunchMode.Type;

/** Observed lifecycle of one protocol-mode turn. */
export const AgentTurnStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);
export type AgentTurnStatus = typeof AgentTurnStatus.Type;

/** Token accounting exactly as the harness reported it. */
export const AgentTurnUsage = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Int),
  outputTokens: Schema.NullOr(Schema.Int),
  cachedInputTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  contextWindow: Schema.NullOr(Schema.Int),
});
export type AgentTurnUsage = typeof AgentTurnUsage.Type;

/**
 * Who opened a turn: `request` is input Mend sent (a person's message, a follow-up), `harness` is
 * a turn the agent started on its own, as Claude does when a background task or workflow ends.
 */
export const AgentTurnOrigin = Schema.Literals(["request", "harness"]);
export type AgentTurnOrigin = typeof AgentTurnOrigin.Type;

/**
 * Whose login a turn ran on (docs/adr/0013-whoever-sends-a-turn-pays.md, "Every turn records its
 * payer"): the person, and the connected account as Core reported it, with the account's name as
 * it was then. Each part is null when Mend cannot say it.
 */
export interface TurnPayer {
  readonly userId: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
}

/** One submitted input and the agent work associated with it. */
export class AgentTurn extends Schema.Class<AgentTurn>("AgentTurn")({
  id: AgentTurnId,
  sessionId: SessionId,
  processId: SessionProcessId,
  /** Position within the session conversation. */
  ordinal: Schema.Int,
  /** Mend user id, or null for a system-authored follow-up. */
  author: Schema.NullOr(Schema.String),
  /** What opened the turn. A `harness` turn's input is what the agent was answering. */
  origin: AgentTurnOrigin.pipe(
    Schema.withConstructorDefault(Effect.succeed<AgentTurnOrigin>("request")),
  ),
  input: Schema.String,
  status: AgentTurnStatus,
  providerTurnId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(AgentTurnUsage),
  /**
   * What the request asked for (docs/adr/0007-landing.md, "Questions do not open pull requests"):
   * null until Mend reads it, and null with source `unread` when it could not.
   */
  intent: Schema.NullOr(RequestIntent).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  intentSource: Schema.NullOr(RequestIntentSource).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * What Mend decided about landing once the turn ended ("When a completed turn lands"): null
   * until it decides, or for a turn that ended before automatic landing existed.
   */
  landing: Schema.NullOr(TurnLanding).pipe(Schema.withConstructorDefault(Effect.succeed(null))),
  /** The automatic landing this turn started, when it `attempted` one and the row remains. */
  landingId: Schema.NullOr(ChangeLandingId).pipe(
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /**
   * Whose login the turn ran on (`TurnPayer`), recorded when Mend sent it or the harness opened
   * it. Null on a turn never sent, one recorded before payers were, and where Mend cannot say.
   */
  billedUserId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The connected account's id as Core reported it; null until Core reports one. */
  billedAccountId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** The connected account's name when the turn ran (`default`, `work`). */
  billedAccountName: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  endedAt: Schema.NullOr(Timestamp),
}) {}

/** Statuses that still occupy, or will occupy, a protocol agent. */
export const OPEN_AGENT_TURN_STATUSES: ReadonlySet<AgentTurnStatus> = new Set([
  "queued",
  "running",
]);

/** Closed item vocabulary shared by protocol adapters and API clients. */
export const AgentItemKind = Schema.Literals([
  "user-message",
  "assistant-message",
  "reasoning",
  "plan",
  "command-execution",
  "file-change",
  "tool-call",
  "web-search",
  /** A background task the agent started: a workflow, a background agent or command. */
  "task",
  "error",
  "other",
]);
export type AgentItemKind = typeof AgentItemKind.Type;

/** Observed lifecycle of a streamed agent item. */
export const AgentItemStatus = Schema.Literals(["in-progress", "completed", "failed", "declined"]);
export type AgentItemStatus = typeof AgentItemStatus.Type;

/** One thing the agent said or did during a turn. */
export class AgentItem extends Schema.Class<AgentItem>("AgentItem")({
  id: AgentItemId,
  sessionId: SessionId,
  processId: SessionProcessId,
  turnId: AgentTurnId,
  /**
   * Session-wide change-feed cursor: bumps on every applied update so `listItems(after)`
   * re-delivers changed items. NOT conversation order — render by `createdAt` or turn ordinal.
   */
  seq: Schema.Int,
  /** Harness item id, unique within the process and used for replay upserts. */
  providerItemId: Schema.String,
  kind: AgentItemKind,
  status: AgentItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  data: Schema.NullOr(Schema.Unknown),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** What a protocol agent is asking a person to decide or answer. */
export const AgentRequestKind = Schema.Literals([
  "command-approval",
  "file-change-approval",
  "tool-permission",
  "user-input",
  "unknown",
]);
export type AgentRequestKind = typeof AgentRequestKind.Type;

/** Observed lifecycle of an agent-to-human request. */
export const AgentRequestStatus = Schema.Literals(["pending", "resolved", "cancelled"]);
export type AgentRequestStatus = typeof AgentRequestStatus.Type;

/** A human decision for an approval request. */
export const AgentApprovalDecision = Schema.Literals([
  "accept",
  "accept-for-session",
  "decline",
  "cancel",
]);
export type AgentApprovalDecision = typeof AgentApprovalDecision.Type;

/** One structured question inside a user-input request. */
export const AgentInputQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.NullOr(Schema.String),
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.NullOr(Schema.String),
    }),
  ),
  multiSelect: Schema.Boolean,
});
export type AgentInputQuestion = typeof AgentInputQuestion.Type;

/** Answers keyed by the provider's question id. */
export const AgentInputAnswers = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type AgentInputAnswers = typeof AgentInputAnswers.Type;

/** A protocol agent request and the recorded human response, when one exists. */
export class AgentRequest extends Schema.Class<AgentRequest>("AgentRequest")({
  id: AgentRequestId,
  sessionId: SessionId,
  processId: SessionProcessId,
  turnId: AgentTurnId,
  kind: AgentRequestKind,
  providerRequestId: Schema.String,
  providerItemId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.Unknown),
  questions: Schema.NullOr(Schema.Array(AgentInputQuestion)),
  status: AgentRequestStatus,
  decision: Schema.NullOr(AgentApprovalDecision),
  /** Mend user id that answered the request. */
  decidedBy: Schema.NullOr(Schema.String),
  answers: Schema.NullOr(AgentInputAnswers),
  createdAt: Timestamp,
  decidedAt: Schema.NullOr(Timestamp),
}) {}

/** Observed lifecycle of a background task, as its harness reported it. */
export const AgentTaskStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "stopped",
  "paused",
]);
export type AgentTaskStatus = typeof AgentTaskStatus.Type;

/** One agent inside a workflow: queued or running (`start`), `done`, or in `error`. */
export const AgentTaskAgent = Schema.Struct({
  index: Schema.Int,
  label: Schema.String,
  phaseIndex: Schema.NullOr(Schema.Int),
  state: Schema.String,
  model: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(Schema.Int),
  toolCalls: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Int),
  lastTool: Schema.NullOr(Schema.String),
  /** The start of the agent's result, or of its error. */
  preview: Schema.NullOr(Schema.String),
});
export type AgentTaskAgent = typeof AgentTaskAgent.Type;

/**
 * The `data` of a `task` item: a background task as Mend records it, whatever the harness's
 * own wire shape. A workflow carries its phases and agents; other tasks leave them empty.
 */
export const AgentTaskData = Schema.Struct({
  taskId: Schema.String,
  /** The harness's task type: `local_workflow`, `local_agent`, `local_bash`, … */
  taskType: Schema.String,
  /** The workflow's name, when the task is one. */
  workflow: Schema.NullOr(Schema.String),
  description: Schema.String,
  status: AgentTaskStatus,
  /** The harness's closing line, once the task ended. */
  summary: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  phases: Schema.Array(Schema.Struct({ index: Schema.Int, title: Schema.String })),
  agents: Schema.Array(AgentTaskAgent),
  totalTokens: Schema.NullOr(Schema.Int),
  toolUses: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(Schema.Int),
});
export type AgentTaskData = typeof AgentTaskData.Type;

/** Adapter-side item state before the engine stamps Mend ids and sequence. */
export const AgentEventItem = Schema.Struct({
  providerItemId: Schema.String,
  providerTurnId: Schema.String,
  kind: AgentItemKind,
  status: AgentItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  data: Schema.NullOr(Schema.Unknown),
});
export type AgentEventItem = typeof AgentEventItem.Type;

/** Adapter-side request state before the engine stamps Mend ids and authorship. */
export const AgentEventRequest = Schema.Struct({
  providerRequestId: Schema.String,
  providerTurnId: Schema.String,
  providerItemId: Schema.NullOr(Schema.String),
  kind: AgentRequestKind,
  title: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.Unknown),
  questions: Schema.NullOr(Schema.Array(AgentInputQuestion)),
});
export type AgentEventRequest = typeof AgentEventRequest.Type;

/** Normalized live event emitted by every protocol adapter. */
export const AgentEvent = Schema.Union([
  Schema.TaggedStruct("session.ready", {
    providerSessionId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("turn.started", {
    providerTurnId: Schema.String,
  }),
  /** The agent started a turn nobody sent; `reason` is what it is answering, when known. */
  Schema.TaggedStruct("harness-turn.started", {
    providerTurnId: Schema.String,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("turn.completed", {
    providerTurnId: Schema.String,
    status: Schema.Literals(["completed", "interrupted", "failed", "cancelled"]),
    usage: Schema.NullOr(AgentTurnUsage),
    error: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("item.updated", { item: AgentEventItem }),
  Schema.TaggedStruct("content.delta", {
    providerItemId: Schema.String,
    providerTurnId: Schema.String,
    delta: Schema.String,
  }),
  Schema.TaggedStruct("request.opened", { request: AgentEventRequest }),
  Schema.TaggedStruct("request.resolved", { providerRequestId: Schema.String }),
  Schema.TaggedStruct("runtime.warning", { message: Schema.String }),
  Schema.TaggedStruct("runtime.error", { message: Schema.String }),
]);
export type AgentEvent = typeof AgentEvent.Type;
