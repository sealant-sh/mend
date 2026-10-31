import { Schema } from "effect";

import { ClientMessageId, SessionMessageId, type AgentTurnId, type SessionId } from "../ids.ts";
import { AgentTurn, type AgentTurnStatus } from "./agent-protocol.ts";
import { AgentTurnSteer, type TurnSteerQueueReason } from "./agent-steer.ts";
import { TURN_DELIVERY_UNCONFIRMED } from "./steering.ts";

export const MessageInput = Schema.String.check(Schema.isPattern(/\S/)).pipe(
  Schema.brand("MessageInput"),
);
export type MessageInput = typeof MessageInput.Type;

export class MessageSettings extends Schema.Class<MessageSettings>("MessageSettings")({
  sendSteersRunningTurn: Schema.Boolean,
}) {}

export const DEFAULT_MESSAGE_SETTINGS = new MessageSettings({ sendSteersRunningTurn: true });

export const MessageTurnReason = Schema.Literals([
  "queue-requested",
  "steering-off",
  "no-own-running-turn",
]);
export type MessageTurnReason = typeof MessageTurnReason.Type;

export const SessionMessageResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Steer"),
    messageId: SessionMessageId,
    steer: AgentTurnSteer,
    explanation: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Turn"),
    messageId: SessionMessageId,
    turn: AgentTurn,
    explanation: Schema.String,
  }),
]);
export type SessionMessageResult = typeof SessionMessageResult.Type;

export interface SendMessageInput {
  readonly sessionId: SessionId;
  readonly sender: string;
  readonly input: MessageInput;
  readonly clientMessageId: ClientMessageId | null;
  readonly intent: "default" | "queue";
}

export type MessageChoice =
  | { readonly _tag: "Steer"; readonly turnId: AgentTurnId }
  | { readonly _tag: "Turn"; readonly reason: MessageTurnReason };

export class MessageKeyConflictError extends Schema.TaggedError<MessageKeyConflictError>()(
  "MessageKeyConflictError",
  {
    clientMessageId: ClientMessageId,
    message: Schema.String,
  },
) {}

export class MessageTargetAmbiguousError extends Schema.TaggedError<MessageTargetAmbiguousError>()(
  "MessageTargetAmbiguousError",
  {
    sessionId: Schema.String,
    message: Schema.String,
  },
) {}

const queueReasons: Record<TurnSteerQueueReason, string> = {
  "no-active-turn": "the agent had no active turn",
  "target-changed": "the agent's active turn changed",
  "review-turn": "the agent was reviewing",
  "compact-turn": "the agent was compacting its conversation",
  "output-schema": "the turn required structured output",
  "invalid-input": "the agent refused this input as a steer",
  "server-draining": "the agent was shutting down",
  unsupported: "the agent does not support steering",
  "in-continuation": "the agent was continuing its turn",
  "not-written": "the words were not written to the running turn",
  "turn-ended": "the running turn ended",
  "not-acknowledged": "the running turn was not acknowledged",
  "not-running": "the selected turn was not running",
  replaying: "Mend was replaying the conversation",
  "handing-over": "the conversation was changing processes",
};

const turnReasons: Record<MessageTurnReason, string> = {
  "queue-requested": "you asked for a new turn",
  "steering-off": "Send steers the running turn is off",
  "no-own-running-turn": "you had no running turn in this session",
};

const endedBeforeStart: Partial<Record<AgentTurnStatus, string>> = {
  cancelled: "the turn was cancelled before it started",
  failed: "the turn failed before it started",
  interrupted: "the turn was interrupted before it started",
};

type MessageObservation =
  | { readonly _tag: "Steer"; readonly messageId: SessionMessageId; readonly steer: AgentTurnSteer }
  | { readonly _tag: "Turn"; readonly messageId: SessionMessageId; readonly turn: AgentTurn };

export function messageOutcome<const O extends MessageObservation>(
  observation: O,
  reason: MessageTurnReason | null,
): O & { readonly explanation: string } {
  if (observation._tag === "Turn") {
    const { status, startedAt, error } = observation.turn;
    const why = reason === null ? "a new turn was recorded" : turnReasons[reason];
    const unsent = startedAt === null ? endedBeforeStart[status] : undefined;
    const explanation =
      unsent !== undefined
        ? `not sent · ${unsent}`
        : status === "failed" && error === TURN_DELIVERY_UNCONFIRMED
          ? "delivery not confirmed · Mend will not resend"
          : status === "queued"
            ? `sent as your next turn · ${why}`
            : `sent as your next turn · ${why} · turn ${status} · observed`;
    return { ...observation, explanation };
  }
  const delivery = observation.steer.delivery;
  const explanation = (() => {
    switch (delivery._tag) {
      case "Accepted":
        return delivery.evidence === "provider-acknowledged"
          ? "sent · the agent acknowledged it"
          : "sent · written to the agent";
      case "Queued":
        return `sent as your next turn · ${queueReasons[delivery.reason]}`;
      case "Sending":
        return "sending";
      case "Unknown":
        return "delivery not confirmed · Mend will not resend";
      case "NotSent":
        return `not sent · ${queueReasons[delivery.reason]}; the session could not take a next turn`;
    }
  })();
  return { ...observation, explanation };
}
