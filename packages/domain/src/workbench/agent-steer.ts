import { Effect, Schema } from "effect";

import { AgentTurnId, AgentTurnSteerId, SessionId, SessionProcessId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { AgentTurn } from "./agent-protocol.ts";

export const TurnSteerQueueReason = Schema.Literals([
  "no-active-turn",
  "target-changed",
  "review-turn",
  "compact-turn",
  "output-schema",
  "invalid-input",
  "server-draining",
  "unsupported",
  "in-continuation",
  "not-written",
  "turn-ended",
  "not-acknowledged",
  "not-running",
  "replaying",
  "handing-over",
]);
export type TurnSteerQueueReason = typeof TurnSteerQueueReason.Type;

export const AgentTurnSteerDelivery = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Sending") }),
  Schema.Struct({
    _tag: Schema.Literal("Accepted"),
    evidence: Schema.Literals(["provider-acknowledged", "transport-written"]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Queued"),
    turnId: AgentTurnId,
    reason: TurnSteerQueueReason,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Unknown"),
    reason: Schema.Literals(["restart", "uncertain", "failed"]),
  }),
  /** Not delivered for `reason`, and the session could not take the words as a turn either. */
  Schema.Struct({ _tag: Schema.Literal("NotSent"), reason: TurnSteerQueueReason }),
]);
export type AgentTurnSteerDelivery = typeof AgentTurnSteerDelivery.Type;

export class AgentTurnSteer extends Schema.Class<AgentTurnSteer>("AgentTurnSteer")({
  id: AgentTurnSteerId,
  sessionId: SessionId,
  processId: SessionProcessId,
  turnId: AgentTurnId,
  author: Schema.String,
  ordinal: Schema.Int,
  input: Schema.String,
  delivery: AgentTurnSteerDelivery,
  queuedTurnId: Schema.NullOr(AgentTurnId),
  clientSteerId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** An author-less turn belongs to its recorded payer, never implicitly to the session owner. */
export const turnSteerSender = (turn: Pick<AgentTurn, "author" | "billedUserId">): string | null =>
  turn.author ?? turn.billedUserId;

export class ConversationTurn extends AgentTurn.extend<ConversationTurn>("ConversationTurn")({
  steers: Schema.Array(AgentTurnSteer).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  steerSender: Schema.NullOr(Schema.String),
  fromSteer: Schema.NullOr(AgentTurnSteerId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

export const AgentProtocolControl = Schema.Struct({
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  controlId: Schema.String,
  providerTurnId: Schema.String,
  afterOutputLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  action: Schema.Literals(["steer-now", "interrupt", "not-written"]),
});
export type AgentProtocolControl = typeof AgentProtocolControl.Type;
