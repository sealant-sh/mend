import { Effect, Schema } from "effect";

import {
  AgentTurnId,
  AgentTurnSteerId,
  ClientMessageId,
  SessionId,
  SessionProcessId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { AgentTurn } from "./agent-protocol.ts";
import { TurnSelection } from "./turn-selection.ts";

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
  /** Requested options, never proof of the model observed. Null means not recorded. */
  selection: Schema.NullOr(TurnSelection).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  delivery: AgentTurnSteerDelivery,
  queuedTurnId: Schema.NullOr(AgentTurnId),
  clientSteerId: Schema.NullOr(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export const turnSteerSender = (turn: Pick<AgentTurn, "author" | "billedUserId">): string | null =>
  turn.author ?? turn.billedUserId;

/**
 * The key a client sent its message under (`POST /sessions/:id/messages`), null for words that
 * came another way. A sender's client lays its pending message over the conversation until a turn
 * or steer with its key arrives, so the message shows once. Absent from older servers.
 */
const MessageKey = Schema.NullOr(ClientMessageId).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
  Schema.withConstructorDefault(Effect.succeed(null)),
);

/** A steer as the conversation reads it: with the key its message was sent under. */
export class ConversationSteer extends AgentTurnSteer.extend<ConversationSteer>(
  "ConversationSteer",
)({ clientMessageId: MessageKey }) {}

export class ConversationTurn extends AgentTurn.extend<ConversationTurn>("ConversationTurn")({
  clientMessageId: MessageKey,
  steers: Schema.Array(ConversationSteer).pipe(
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

export class TurnSteerForbiddenError extends Schema.TaggedError<TurnSteerForbiddenError>()(
  "TurnSteerForbiddenError",
  {
    turnId: Schema.String,
    reason: Schema.Literals(["not-sender", "no-sender"]),
    message: Schema.String,
  },
) {}
